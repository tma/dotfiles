import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	fetchSearxngResults,
	parseSearxngResults,
	resolveSearxngConfig,
	searxngEnvFile,
	searxngRepoEnvFile,
	searxngSearchUrl,
	searxngUrlFromText,
} from "../extensions/lib/searxng.ts";

test("searxngUrlFromText reads the last SEARXNG_URL and ignores other keys", () => {
	assert.equal(
		searxngUrlFromText(`
# comment
export PAPERLESS_URL=http://paperless.example:8000
SEARXNG_URL=http://searx.example:8080
export SEARXNG_URL="http://searx.example:9090"
`),
		"http://searx.example:9090",
	);
	assert.equal(searxngUrlFromText("SEARXNG_URL=''\n"), null);
});

test("resolveSearxngConfig prefers the process environment and does not read files", () => {
	const config = resolveSearxngConfig({
		env: { SEARXNG_URL: " http://127.0.0.1:8080 " },
		home: "/tmp/unused",
		readFile: () => {
			throw new Error("should not read an env file");
		},
	});
	assert.deepEqual(config, { status: "ready", url: "http://127.0.0.1:8080" });
});

test("resolveSearxngConfig reads ~/.pi/.env and not a project .env", () => {
	const home = mkdtempSync(path.join(tmpdir(), "pi-searxng-home-"));
	const repoEnv = path.join(home, "repo", ".pi", ".env");
	const reads: string[] = [];
	const config = resolveSearxngConfig({
		env: {},
		home,
		repoEnvFile: repoEnv,
		cwd: path.join(home, "project"),
		readFile: (file) => {
			reads.push(file);
			if (file === searxngEnvFile(home)) return "SEARXNG_URL=http://10.0.0.8:8080\nPAPERLESS_TOKEN=secret\n";
			return "SEARXNG_URL=http://127.0.0.1:1\n";
		},
	});
	assert.deepEqual(config, { status: "ready", url: "http://10.0.0.8:8080" });
	assert.deepEqual(reads, [searxngEnvFile(home)]);
});

test("resolveSearxngConfig falls back to the repo .pi/.env", () => {
	const home = mkdtempSync(path.join(tmpdir(), "pi-searxng-home-"));
	const repoEnv = path.join(home, "repo.env");
	const reads: string[] = [];
	const config = resolveSearxngConfig({
		env: {},
		home,
		repoEnvFile: repoEnv,
		readFile: (file) => {
			reads.push(file);
			if (file === repoEnv) return "SEARXNG_URL=http://127.0.0.1:8080\n";
			return null;
		},
	});
	assert.deepEqual(config, { status: "ready", url: "http://127.0.0.1:8080" });
	assert.deepEqual(reads, [searxngEnvFile(home), repoEnv]);
});

test("resolveSearxngConfig reads ~/.pi/.env and PI_SEARXNG_ENV from disk", () => {
	const home = mkdtempSync(path.join(tmpdir(), "pi-searxng-real-"));
	mkdirSync(path.join(home, ".pi"));
	writeFileSync(path.join(home, ".pi", ".env"), "export SEARXNG_URL=http://127.0.0.1:8080\n");
	assert.deepEqual(resolveSearxngConfig({ env: {}, home }), {
		status: "ready",
		url: "http://127.0.0.1:8080",
	});

	const file = path.join(home, "search.env");
	writeFileSync(file, "SEARXNG_URL=http://192.168.1.9:8888\n");
	assert.deepEqual(resolveSearxngConfig({ env: { PI_SEARXNG_ENV: file }, home: path.join(home, "ignored") }), {
		status: "ready",
		url: "http://192.168.1.9:8888",
	});
});

test("resolveSearxngConfig reports a missing PI_SEARXNG_ENV file", () => {
	const config = resolveSearxngConfig({
		env: { PI_SEARXNG_ENV: "missing.env" },
		home: "/tmp/unused",
		cwd: "/tmp",
		readFile: () => null,
	});
	assert.equal(config.status, "invalid");
	if (config.status === "invalid") assert.equal(config.error, "PI_SEARXNG_ENV file is missing or unreadable");
});

test("resolveSearxngConfig rejects unsafe URLs without echoing them", () => {
	const config = resolveSearxngConfig({
		env: { SEARXNG_URL: "http://user:secret@searx.example" },
		home: "/tmp/unused",
	});
	assert.equal(config.status, "invalid");
	if (config.status === "invalid") {
		assert.match(config.error, /credentials/);
		assert.equal(config.error.includes("secret"), false);
	}
});

test("searxngSearchUrl adds /search and format=json once", () => {
	const url = new URL(searxngSearchUrl("http://127.0.0.1:8080/", "pi agent"));
	assert.equal(url.pathname, "/search");
	assert.equal(url.searchParams.get("q"), "pi agent");
	assert.equal(url.searchParams.get("format"), "json");

	const already = new URL(searxngSearchUrl("http://searx.example/searx/search?format=json", "q"));
	assert.equal(already.pathname, "/searx/search");
	assert.equal(already.searchParams.get("format"), "json");
});

test("parseSearxngResults maps JSON and rejects HTML", () => {
	assert.deepEqual(
		parseSearxngResults(
			JSON.stringify({
				results: [
					{ title: "<b>One</b>", url: "https://example.com/a", content: "a &amp; b" },
					{ title: "skip", url: "ftp://example.com/x", content: "" },
					{ title: "", url: "https://example.com/empty", content: "" },
				],
			}),
		),
		[{ title: "One", url: "https://example.com/a", snippet: "a & b" }],
	);
	assert.throws(() => parseSearxngResults("<html>format disabled</html>"), /JSON format disabled/);
	assert.deepEqual(parseSearxngResults('{"results":[]}'), []);
});

test("fetchSearxngResults refuses a redirect onto another port", async () => {
	const otherHits: string[] = [];
	const other = await listen((req, res) => {
		otherHits.push(req.url ?? "");
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end('{"results":[{"title":"other","url":"https://example.com/other","content":"no"}]}');
	});
	const searx = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/search" && url.searchParams.get("format") === "json") {
			res.writeHead(302, { Location: `${other.url}/search` });
			res.end();
			return;
		}
		res.writeHead(404);
		res.end();
	});

	try {
		await assert.rejects(
			fetchSearxngResults(searx.url, "query", { timeoutMs: 2_000 }),
			/redirect left the SearXNG host/,
		);
		assert.deepEqual(otherHits, []);
	} finally {
		await searx.close();
		await other.close();
	}
});

test("fetchSearxngResults follows a same-host redirect and returns results", async () => {
	const searx = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/search") {
			res.writeHead(302, { Location: "/results?q=kept" });
			res.end();
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ results: [{ title: "Local hit", url: "https://example.com/hit", content: "from searxng" }] }));
	});

	try {
		const results = await fetchSearxngResults(`${searx.url}/`, "pi", { timeoutMs: 2_000 });
		assert.deepEqual(results, [{ title: "Local hit", url: "https://example.com/hit", snippet: "from searxng" }]);
	} finally {
		await searx.close();
	}
});

function listen(
	handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer(handler);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("test server has no port"));
				return;
			}
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				close: () =>
					new Promise((done, fail) => {
						server.close((error) => (error ? fail(error) : done()));
					}),
			});
		});
	});
}
