import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const LMSTUDIO_PROVIDER = "lmstudio";

test("blockedProvider lists no models, never resolves auth, and never streams", async () => {
	const { blockedProvider } = await import("../extensions/lib/local-only.ts");
	const provider = blockedProvider("example-cloud");
	assert.equal(provider.id, "example-cloud");
	assert.deepEqual(provider.getModels(), []);
	assert.equal(provider.auth.oauth, undefined);
	const signal = new AbortController().signal;
	const ctx = { env: async () => "example-not-a-key", fileExists: async () => true };
	assert.equal(await provider.auth.apiKey?.resolve({ ctx, signal }), undefined);
	assert.equal(
		await provider.auth.apiKey?.resolve({ ctx, signal, credential: { type: "api_key", key: "example-not-a-key" } }),
		undefined,
	);
	const model = { id: "m", provider: "example-cloud" } as never;
	assert.throws(() => provider.streamSimple(model, { messages: [] } as never), /pi-local/);
	assert.throws(() => provider.stream(model, { messages: [] } as never), /pi-local/);
});

// Real-Pi integration is optional, like .pi/agent/tests. It loads the actual
// profile (settings, models.json, extensions) into a temporary agent directory
// with memory credentials. Cloud models point at a local recording server, so
// a guard failure shows up as a local hit, never as a real request.
const nodeModules = process.env.PI_TEST_NODE_MODULES;
test("real Pi local-only profile", {
	skip: nodeModules === undefined ? "Set PI_TEST_NODE_MODULES to an external Pi node_modules directory (see .pi/agent/tests/README.md)" : false,
}, async (t) => {
	assert.ok(nodeModules, "PI_TEST_NODE_MODULES must be a nonempty node_modules path");
	const packageDir = join(nodeModules, "@earendil-works/pi-coding-agent");
	const version = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version;
	t.diagnostic(`Testing supplied Pi ${version}`);
	const piAiDir = await firstExisting([
		join(nodeModules, "@earendil-works/pi-ai"),
		join(packageDir, "node_modules/@earendil-works/pi-ai"),
	]);
	const sdk = await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
	const { InMemoryCredentialStore } = await import(pathToFileURL(join(piAiDir, "dist/index.js")).href);
	const { builtinProviders } = await import(pathToFileURL(join(piAiDir, "dist/providers/all.js")).href);

	const savedEnv = Object.fromEntries(
		["PI_OFFLINE", "OPENAI_API_KEY", "LM_STUDIO_URL", "PI_LOCAL_ENV", "PI_LOCAL_LAUNCH_DIR"].map((key) => [key, process.env[key]]),
	);
	const root = await mkdtemp(join(tmpdir(), "pi-local-real-"));
	t.after(async () => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});

	const agentDir = join(root, "agent");
	const cwd = join(root, "launch");
	for (const entry of ["settings.json", "models.json", "extensions"]) {
		await cp(new URL(`../${entry}`, import.meta.url), join(agentDir, entry), { recursive: true });
	}
	await cp(new URL("../SYSTEM.md", import.meta.url), join(agentDir, "SYSTEM.md"));
	await writeFile(join(root, "empty.env"), "");
	await mkdir(cwd);
	const extensionFiles = (await readdir(join(agentDir, "extensions")))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(agentDir, "extensions", name));

	process.env.PI_OFFLINE = "1";
	process.env.PI_LOCAL_ENV = join(root, "empty.env");
	process.env.PI_LOCAL_LAUNCH_DIR = cwd;
	// Inherited cloud credentials: one ambient, one stored.
	process.env.OPENAI_API_KEY = "example-not-a-key";

	const lmStudio = await recordingServer(t, (req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ data: [{ id: "local-test-model", type: "llm" }] }));
	});
	const cloud = await recordingServer(t, (_req, res) => {
		res.statusCode = 500;
		res.end("{}");
	});
	const lmAbsent = await closedPortUrl();

	async function services(lmStudioUrl: string) {
		process.env.LM_STUDIO_URL = lmStudioUrl;
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "example-not-a-key" }));
		const modelRuntime = await sdk.ModelRuntime.create({
			credentials,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const result = await sdk.createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				// Same explicit files the pi-local launcher passes with --no-extensions.
				additionalExtensionPaths: extensionFiles,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		assert.deepEqual(result.resourceLoader.getExtensions().errors, []);
		assert.deepEqual(result.diagnostics.filter((d: { type: string }) => d.type === "error"), []);
		return result;
	}

	async function session(svc: unknown, sessionManager?: unknown, model?: unknown) {
		const { session } = await sdk.createAgentSessionFromServices({
			services: svc,
			sessionManager: sessionManager ?? sdk.SessionManager.inMemory(cwd),
			...(model ? { model } : {}),
		});
		t.after(() => session.dispose());
		return session;
	}

	// pi-agent-core reports a missing model as an "unknown" placeholder.
	function selected(s: { model?: { provider: string; id: string } }) {
		return s.model && s.model.provider !== "unknown" ? `${s.model.provider}/${s.model.id}` : undefined;
	}

	function cloudModel(providerId: string) {
		const model = builtinProviders().find((p: { id: string }) => p.id === providerId).getModels()[0];
		return { ...model, baseUrl: cloud.url };
	}

	await t.test("startup picks an LM Studio model despite cloud credentials", async () => {
		const svc = await services(lmStudio.url);
		const s = await session(svc);
		assert.equal(selected(s), `${LMSTUDIO_PROVIDER}/local-test-model`);
		assert.equal(svc.modelRuntime.getModels().some((m: { provider: string }) => m.provider !== LMSTUDIO_PROVIDER), false);
	});

	await t.test("startup has no model, not a cloud fallback, when LM Studio is absent", async () => {
		const svc = await services(lmAbsent);
		const s = await session(svc);
		assert.equal(selected(s), undefined);
		assert.deepEqual(svc.modelRuntime.getAvailableSnapshot(), []);
	});

	await t.test("explicit --provider/--model cloud selection fails", async () => {
		const svc = await services(lmStudio.url);
		for (const options of [
			{ cliModel: "anthropic/claude-opus-4-8" },
			{ cliProvider: "openai", cliModel: "gpt-5.5" },
			{ cliModel: "gpt-5.5" },
		]) {
			const resolved = sdk.resolveCliModel({ ...options, modelRuntime: svc.modelRuntime });
			assert.equal(resolved.model, undefined, JSON.stringify(options));
			assert.ok(resolved.error, JSON.stringify(options));
		}
		const local = sdk.resolveCliModel({ cliProvider: "lmstudio", cliModel: "local-test-model", modelRuntime: svc.modelRuntime });
		assert.equal(local.model?.provider, LMSTUDIO_PROVIDER);
	});

	await t.test("resumed cloud session does not restore the cloud model", async () => {
		for (const url of [lmStudio.url, lmAbsent]) {
			const svc = await services(url);
			const sessionManager = sdk.SessionManager.inMemory(cwd);
			sessionManager.appendModelChange("anthropic", cloudModel("anthropic").id);
			sessionManager.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
			const s = await session(svc, sessionManager);
			assert.equal(selected(s), url === lmAbsent ? undefined : `${LMSTUDIO_PROVIDER}/local-test-model`);
		}
	});

	await t.test("a cloud model object fails before any request leaves Pi", async () => {
		const svc = await services(lmStudio.url);
		for (const providerId of ["anthropic", "openai"]) {
			const model = cloudModel(providerId);
			const message = await svc.modelRuntime.completeSimple(model, {
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			});
			assert.equal(message.stopReason, "error", providerId);
			const s = await session(svc, undefined, model);
			await s.prompt("hello").catch(() => undefined);
		}
		assert.equal(cloud.hits.length, 0, `cloud requests reached the network boundary: ${cloud.hits.join(", ")}`);
	});

	await t.test("pi-local CLI: no cloud fallback, cloud flags fail, LM chat bypasses proxies", async () => {
		const shellrc = await readFile(new URL("../../../.shellrc", import.meta.url), "utf8");
		const launcher = shellrc.match(/^pi-local\(\) \{[\s\S]*?^\}/m)?.[0];
		assert.ok(launcher, ".shellrc must define pi-local()");
		const bin = join(root, "bin");
		const home = join(root, "home");
		await mkdir(bin);
		await mkdir(home);
		await writeFile(join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${join(packageDir, "dist/cli.js")}" "$@"\n`);
		await chmod(join(bin, "pi"), 0o755);
		const proxy = await recordingProxy(t);
		const chat = await recordingServer(t, (req, res) => {
			if (req.method === "POST") {
				req.resume();
				req.on("end", () => {
					res.writeHead(200, { "content-type": "text/event-stream" });
					const chunk = (choice: unknown, usage?: unknown) =>
						res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "local-test-model", choices: [choice], ...(usage ? { usage } : {}) })}\n\n`);
					chunk({ index: 0, delta: { role: "assistant", content: "local reply" }, finish_reason: null });
					chunk({ index: 0, delta: {}, finish_reason: "stop" }, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
					res.end("data: [DONE]\n\n");
				});
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "local-test-model", type: "llm" }] }));
		});

		// Async spawn: the fake servers live in this process and must keep serving.
		function piLocal(args: string, lmStudioUrl: string) {
			return run("bash", ["-c", `${launcher}\npi-local ${args} </dev/null`], {
				cwd,
				env: {
					HOME: home,
					PATH: `${bin}:/usr/bin:/bin`,
					PI_LOCAL_DIR: agentDir,
					LM_STUDIO_URL: lmStudioUrl,
					OPENAI_API_KEY: "example-not-a-key",
					ANTHROPIC_API_KEY: "example-not-a-key",
					HTTP_PROXY: proxy.url,
					HTTPS_PROXY: proxy.url,
					http_proxy: proxy.url,
					https_proxy: proxy.url,
				},
			});
		}

		const absent = await piLocal("-p --no-session hello", lmAbsent);
		assert.notEqual(absent.status, 0, absent.stdout);
		const cloudFlag = await piLocal("-p --no-session --provider openai --model gpt-5.5 hello", chat.url);
		assert.notEqual(cloudFlag.status, 0, cloudFlag.stdout);
		const local = await piLocal("-p --no-session hello", chat.url);
		assert.equal(local.status, 0, local.stderr);
		assert.match(local.stdout, /local reply/);
		assert.ok(chat.hits.some((hit) => hit.startsWith("POST /v1/chat/completions")), chat.hits.join(", "));
		assert.deepEqual(proxy.hits, [], "LM Studio chat must not go through an inherited proxy");
		assert.deepEqual(cloud.hits, []);
	});
});

function run(command: string, args: string[], options: SpawnOptions): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

async function recordingProxy(t: test.TestContext): Promise<{ url: string; hits: string[] }> {
	const hits: string[] = [];
	const server: Server = createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		res.statusCode = 502;
		res.end();
	});
	server.on("connect", (req, socket) => {
		hits.push(`CONNECT ${req.url}`);
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

async function firstExisting(paths: string[]): Promise<string> {
	for (const candidate of paths) {
		try {
			await readFile(join(candidate, "package.json"));
			return candidate;
		} catch {
			// Try the next layout.
		}
	}
	throw new Error(`None of these exist: ${paths.join(", ")}`);
}

async function recordingServer(
	t: test.TestContext,
	handle: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; hits: string[] }> {
	const hits: string[] = [];
	const server: Server = createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		handle(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

async function closedPortUrl(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${port}`;
}
