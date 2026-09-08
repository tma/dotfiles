import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { CatalogRefreshCoordinator } from "../extensions/lib/model-selection.ts";

// Real-Pi tests are optional; an explicitly configured but invalid installation fails.
const nodeModules = process.env.PI_TEST_NODE_MODULES;
test("real Pi child runtime integration", {
	skip: nodeModules === undefined ? "Set PI_TEST_NODE_MODULES to an external Pi node_modules directory (see tests/README.md)" : false,
}, async (t) => {
	assert.ok(nodeModules, "PI_TEST_NODE_MODULES must be a nonempty node_modules path");
	process.env.PI_OFFLINE = "1";
	const packageDir = join(nodeModules, "@earendil-works/pi-coding-agent");
	const version = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version;
	t.diagnostic(`Testing supplied Pi ${version}`);
	const {
		createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
	} = await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
	const { InMemoryCredentialStore } = await import(pathToFileURL(join(nodeModules, "@earendil-works/pi-ai/dist/index.js")).href);

	const source = await readFile(new URL("../extensions/subagent.ts", import.meta.url), "utf8");
	const helper = source.match(/^async function getChildModelRuntime\b[\s\S]*?^\}/m)?.[0];
	assert.ok(helper, "Launcher must define getChildModelRuntime");

	async function memoryRuntime(options = {}) {
		return ModelRuntime.create({ ...options, credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	}

	// Execute the launcher's actual helper without loading unrelated Gondolin/UI
	// extensions. Only disk storage is replaced; each call uses a real Pi runtime.
	const getChildModelRuntime = new Function("ModelRuntime", `
		${stripTypeScriptTypes(helper!)}
		return getChildModelRuntime;
	`)({ create: memoryRuntime });

	async function childRuntime(parent: InstanceType<typeof ModelRuntime>) {
		return getChildModelRuntime({ modelRegistry: new ModelRegistry(parent) });
	}

	function definition(id: string) {
		return {
			id, name: id, reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192, maxTokens: 1024,
		};
	}

	await t.test("child runtime preserves compatibility per-model auth headers", async () => {
		const parent = await memoryRuntime();
		parent.registerProvider("compat-test", {
			api: "openai-completions", baseUrl: "https://example.com/v1", apiKey: "test-key",
			models: [{ ...definition("test-model"), headers: { "x-required": "test-header" } }],
		});
		await parent.refresh({ allowNetwork: false });
		const selected = parent.getModel("compat-test", "test-model");
		assert.ok(selected);
		assert.equal(selected.headers, undefined);
		const parentAuth = await parent.getAuth(selected);
		assert.equal(parentAuth?.auth.headers?.["x-required"], "test-header");

		const child = await childRuntime(parent);
		assert.ok(child.getRegisteredProviderConfig(selected.provider));
		assert.equal(child.getRegisteredNativeProvider(selected.provider), undefined);
		assert.deepEqual(await child.getAuth(selected), parentAuth);
		assert.deepEqual(await child.getAuth(child.getModel(selected.provider, selected.id)), parentAuth);
	});

	await t.test("child runtime preserves genuine native providers and header-only auth", async () => {
		const parent = await memoryRuntime();
		const selected = { ...definition("native-model"), provider: "native-test", api: "openai-completions", baseUrl: "https://example.com/v1" };
		const noStream = () => { throw new Error("Test must not stream"); };
		const provider = {
			id: selected.provider, name: "Native Test",
			auth: { apiKey: { name: "Test headers", resolve: async () => ({ auth: { headers: { "x-required": "native-header" } }, source: "test" }) } },
			getModels: () => [selected], stream: noStream, streamSimple: noStream,
		};
		parent.registerNativeProvider(provider);
		await parent.refresh({ allowNetwork: false });
		const child = await childRuntime(parent);
		assert.equal(child.getRegisteredNativeProvider(selected.provider), provider);
		assert.equal(child.getRegisteredProviderConfig(selected.provider), undefined);
		const auth = await child.getAuth(selected);
		assert.equal(auth?.auth.apiKey, undefined);
		assert.equal(auth?.auth.headers?.["x-required"], "native-header");
		assert.deepEqual(auth, await parent.getAuth(selected));
	});

	await t.test("child session accepts a freshly discovered model absent from its own catalog", async () => {
		const parent = await memoryRuntime();
		let discovered = false;
		parent.registerProvider("discovery-test", {
			api: "openai-completions", baseUrl: "https://example.com/v1", apiKey: "test-key",
			models: [definition("old-model")],
			refreshModels: async () => [definition(discovered ? "new-model" : "old-model")],
		});
		discovered = true;
		await parent.refresh({ allowNetwork: false });
		const selected = parent.getModel("discovery-test", "new-model");
		assert.ok(selected);
		discovered = false;
		const child = await childRuntime(parent);
		await child.refresh({ allowNetwork: false });
		assert.equal(child.getModel(selected.provider, selected.id), undefined);
		assert.ok(child.getProvider(selected.provider));
		assert.equal((await child.getAuth(selected))?.auth.apiKey, "test-key");

		const agentDir = await mkdtemp(join(tmpdir(), "pi-child-runtime-test-"));
		try {
			const settingsManager = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({
				cwd: agentDir, agentDir, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			});
			await loader.reload();
			const { session } = await createAgentSession({
				cwd: agentDir, agentDir, model: selected, modelRuntime: child, thinkingLevel: "off", tools: [],
				resourceLoader: loader, sessionManager: SessionManager.inMemory(agentDir), settingsManager,
			});
			try {
				assert.equal(session.model, selected);
				assert.equal((await child.getAuth(session.model))?.auth.apiKey, "test-key");
			} finally {
				session.dispose();
			}
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	await t.test("child routing follows actual unregister/re-register and isolates parents", async () => {
		const first = await memoryRuntime();
		const second = await memoryRuntime();
		const registry = new ModelRegistry(first);
		const makeProvider = (label: string) => ({
			id: "openai", name: label,
			auth: { apiKey: { name: label, resolve: async () => ({ auth: { headers: { "x-route": label } } }) } },
			getModels: () => [],
			stream: () => { throw new Error("Test must not stream"); },
			streamSimple: () => { throw new Error("Test must not stream"); },
		});
		const routeA = makeProvider("a");
		const routeB = makeProvider("b");
		first.registerNativeProvider(routeA);
		second.registerNativeProvider(routeB);
		const childA = await getChildModelRuntime({ modelRegistry: registry });
		const childB = await childRuntime(second);
		assert.notEqual(childA, childB);
		assert.equal(childA.getRegisteredNativeProvider("openai"), routeA);
		assert.equal(childB.getRegisteredNativeProvider("openai"), routeB);

		registry.unregisterProvider("openai");
		const restored = await getChildModelRuntime({ modelRegistry: registry });
		assert.equal(restored.getRegisteredNativeProvider("openai"), undefined);
		assert.equal(restored.getRegisteredProviderConfig("openai"), undefined);
		assert.equal(restored.getProvider("openai")?.name, first.getProvider("openai")?.name);

		registry.registerProvider("openai", { baseUrl: "https://example.com/first", headers: { "x-old": "old" } });
		const compatibility = await getChildModelRuntime({ modelRegistry: registry });
		assert.equal(compatibility.getRegisteredProviderConfig("openai")?.headers?.["x-old"], "old");
		registry.unregisterProvider("openai");
		registry.registerProvider("openai", { baseUrl: "https://example.com/second" });
		const replaced = await getChildModelRuntime({ modelRegistry: registry });
		assert.equal(replaced.getRegisteredProviderConfig("openai")?.baseUrl, "https://example.com/second");
		assert.equal(replaced.getRegisteredProviderConfig("openai")?.headers, undefined);
		assert.equal(childB.getRegisteredNativeProvider("openai"), routeB);
	});

	await t.test("known blocker: runtime-only parent credentials are not available to an independent child", async (t) => {
		const parent = await memoryRuntime();
		const selected = { ...definition("runtime-only"), provider: "runtime-only-test", api: "openai-completions", baseUrl: "https://example.com/v1" };
		parent.registerNativeProvider({
			id: selected.provider, name: "Runtime-only test",
			auth: { apiKey: { name: "Memory credential", resolve: async ({ credential }: any) => credential?.key
				? { auth: { apiKey: credential.key } } : undefined } },
			getModels: () => [selected],
			stream: () => { throw new Error("Test must not stream"); },
			streamSimple: () => { throw new Error("Test must not stream"); },
		});
		await parent.setRuntimeApiKey(selected.provider, "test-memory-only-key");
		assert.equal((await new ModelRegistry(parent).getApiKeyAndHeaders(selected)).ok, true);
		const child = await childRuntime(parent);
		assert.equal(await child.getAuth(selected), undefined);
		assert.equal(await child.checkAuth(selected.provider), undefined);
		t.diagnostic("Reproduced unresolved auth propagation: public registry APIs expose request auth, not credentials or a shareable runtime.");
		await parent.removeRuntimeApiKey(selected.provider);
		assert.equal(await parent.getAuth(selected), undefined);
	});

	await t.test("actual availability failure appears only in registry.getError and uses short refresh TTL", async () => {
		const parent = await memoryRuntime();
		parent.registerNativeProvider({
			id: "auth-check-error", name: "Auth check error",
			auth: { apiKey: { name: "Failing check", check: async () => { throw new Error("test availability failure"); }, resolve: async () => undefined } },
			getModels: () => [],
			stream: () => { throw new Error("Test must not stream"); },
			streamSimple: () => { throw new Error("Test must not stream"); },
		});
		const registry = new ModelRegistry(parent);
		const refreshed = await registry.refresh({ allowNetwork: false });
		assert.equal(refreshed.aborted, false);
		assert.equal(refreshed.errors.size, 0);
		assert.match(registry.getError()!, /test availability failure/);
		let now = 0;
		let calls = 0;
		const coordinator = new CatalogRefreshCoordinator({ now: () => now, failureTtlMs: 10, successTtlMs: 100 });
		const counted = {
			refresh: (options: any) => { calls++; return registry.refresh(options); },
			getError: () => registry.getError(),
		};
		const report = await coordinator.refresh(counted, false);
		assert.equal(report.stale, true);
		assert.match(report.notice!, /test availability failure/);
		now = 11;
		await coordinator.refresh(counted, false);
		assert.equal(calls, 2);
	});
});
