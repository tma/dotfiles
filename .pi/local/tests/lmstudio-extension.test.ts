import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

type Registered = { name: string; config: { baseUrl?: string; models?: Array<{ id: string }> } };
type Notice = { message: string; level: string };

let loadCount = 0;

// Run the actual exported lmstudio extension against a fake ExtensionAPI.
async function loadExtension(t: test.TestContext, lmStudioUrl: string) {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-local-lmstudio-"));
	const envFile = path.join(dir, "empty.env");
	writeFileSync(envFile, "");
	const saved = { LM_STUDIO_URL: process.env.LM_STUDIO_URL, PI_LOCAL_ENV: process.env.PI_LOCAL_ENV };
	t.after(() => {
		rmSync(dir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	process.env.LM_STUDIO_URL = lmStudioUrl;
	process.env.PI_LOCAL_ENV = envFile;

	const registered: Registered[] = [];
	const notices: Notice[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		registerProvider(name: string, config: Registered["config"]) {
			registered.push({ name, config });
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	// A fresh module instance per case, like Pi's uncached extension loader.
	const { default: extension } = await import(`../extensions/lmstudio.ts?case=${++loadCount}`);
	await extension(pi);
	const ctx = { ui: { notify: (message: string, level: string) => notices.push({ message, level }) } };
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
	return { registered, notices };
}

async function fakeLmStudio(t: test.TestContext, models: unknown[]): Promise<string> {
	const server: Server = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/v0/models" || req.url === "/v1/models") {
			res.end(JSON.stringify({ data: models }));
			return;
		}
		res.statusCode = 404;
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closedPortUrl(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${port}`;
}

test("lmstudio registers discovered models on the configured IP literal", async (t) => {
	const url = await fakeLmStudio(t, [{ id: "local-test-model", type: "llm" }, { id: "embed", type: "embeddings" }]);
	const { registered } = await loadExtension(t, url);
	assert.equal(registered.length, 1);
	assert.equal(registered[0].name, "lmstudio");
	assert.equal(registered[0].config.baseUrl, `${url}/v1`);
	assert.deepEqual(registered[0].config.models?.map((model) => model.id), ["local-test-model"]);
});

test("lmstudio refuses a hostname endpoint so chat cannot follow changed DNS", async (t) => {
	const { registered, notices } = await loadExtension(t, "http://lmstudio.invalid:1234");
	assert.equal(
		registered.some((entry) => entry.config.baseUrl?.includes("lmstudio.invalid")),
		false,
		"chat baseUrl must never carry a hostname",
	);
	assert.deepEqual(registered.map((entry) => entry.config.models), [[]], "explicitly no models");
	assert.ok(notices.some((notice) => /IP address/.test(notice.message)), JSON.stringify(notices));
});

test("lmstudio registers an explicit empty model list when LM Studio is not running", async (t) => {
	const { registered, notices } = await loadExtension(t, await closedPortUrl());
	assert.deepEqual(registered.map((entry) => entry.config.models), [[]]);
	assert.ok(notices.some((notice) => notice.level === "warning"));
});
