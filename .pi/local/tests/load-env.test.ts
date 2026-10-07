import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyDotEnv, loadLocalEnv, parseDotEnv } from "../extensions/lib/load-env.ts";

const ENV_KEYS = [
	"PAPERLESS_URL",
	"PAPERLESS_TOKEN",
	"LM_STUDIO_URL",
	"PI_LOCAL_ENV",
	"PI_LOCAL_LAUNCH_DIR",
	"PWD",
	"PI_OFFLINE",
	"OPENAI_API_KEY",
	"NODE_OPTIONS",
];

// Runs fn with a controlled environment, then restores every key it may touch.
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	try {
		for (const key of ["PAPERLESS_URL", "PAPERLESS_TOKEN", "LM_STUDIO_URL", "PI_LOCAL_ENV", "PI_LOCAL_LAUNCH_DIR"]) {
			delete process.env[key];
		}
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function tempDir(t: test.TestContext, prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("parseDotEnv reads data only: export prefix, outer quotes, full-line comments", () => {
	assert.deepEqual(
		parseDotEnv(`
# comment
export PAPERLESS_URL=http://paperless.example.local:8000
PAPERLESS_TOKEN="secret value"
LM_STUDIO_URL='http://127.0.0.1:1234'
not a line
=broken
`),
		{
			PAPERLESS_URL: "http://paperless.example.local:8000",
			PAPERLESS_TOKEN: "secret value",
			LM_STUDIO_URL: "http://127.0.0.1:1234",
		},
	);
});

test("parseDotEnv keeps $, backticks, and # literally", () => {
	assert.deepEqual(parseDotEnv("PAPERLESS_TOKEN=$(touch pwned)\nPAPERLESS_URL=`id`#frag\nLM_STUDIO_URL=\"$HOME\"\n"), {
		PAPERLESS_TOKEN: "$(touch pwned)",
		PAPERLESS_URL: "`id`#frag",
		LM_STUDIO_URL: "$HOME",
	});
});

test("applyDotEnv applies only the supported local keys", () => {
	withEnv({ PI_OFFLINE: "1", OPENAI_API_KEY: undefined, NODE_OPTIONS: undefined }, () => {
		const applied = applyDotEnv(
			"PI_OFFLINE=0\nOPENAI_API_KEY=example-not-a-key\nNODE_OPTIONS=--require=/tmp/x.js\nPAPERLESS_TOKEN=abc\n",
		);
		assert.deepEqual(applied, ["PAPERLESS_TOKEN"]);
		assert.equal(process.env.PI_OFFLINE, "1");
		assert.equal(process.env.OPENAI_API_KEY, undefined);
		assert.equal(process.env.NODE_OPTIONS, undefined);
		assert.equal(process.env.PAPERLESS_TOKEN, "abc");
	});
});

test("applyDotEnv does not override explicitly exported settings", () => {
	withEnv({ PAPERLESS_URL: "http://10.0.0.9:8000", LM_STUDIO_URL: "" }, () => {
		const applied = applyDotEnv("PAPERLESS_URL=http://10.0.0.5:8000\nLM_STUDIO_URL=http://10.0.0.6:1234\nPAPERLESS_TOKEN=abc\n");
		assert.deepEqual(applied, ["PAPERLESS_TOKEN"]);
		assert.equal(process.env.PAPERLESS_URL, "http://10.0.0.9:8000");
		assert.equal(process.env.LM_STUDIO_URL, "");
	});
});

test("loadLocalEnv reads cwd .env into process.env", (t) => {
	const dir = tempDir(t, "pi-local-env-");
	writeFileSync(path.join(dir, ".env"), "PAPERLESS_URL=http://10.0.0.5:8000\n");
	withEnv({ PWD: dir }, () => {
		const loaded = loadLocalEnv(dir);
		assert.equal(loaded.path, path.join(dir, ".env"));
		assert.deepEqual(loaded.keys, ["PAPERLESS_URL"]);
		assert.equal(process.env.PAPERLESS_URL, "http://10.0.0.5:8000");
	});
});

test("loadLocalEnv finds .env via PI_LOCAL_LAUNCH_DIR before cwd", (t) => {
	const launch = tempDir(t, "pi-local-env-launch-");
	const cwd = tempDir(t, "pi-local-env-cwd-");
	writeFileSync(path.join(launch, ".env"), "PAPERLESS_TOKEN=from-launch-dir\n");
	writeFileSync(path.join(cwd, ".env"), "PAPERLESS_TOKEN=from-cwd\n");
	withEnv({ PI_LOCAL_LAUNCH_DIR: launch, PWD: cwd }, () => {
		const loaded = loadLocalEnv(cwd);
		assert.equal(loaded.path, path.join(launch, ".env"));
		assert.equal(process.env.PAPERLESS_TOKEN, "from-launch-dir");
	});
});

test("loadLocalEnv uses only PI_LOCAL_ENV when it is set", (t) => {
	const dir = tempDir(t, "pi-local-env-explicit-");
	const explicit = path.join(dir, "local.env");
	writeFileSync(explicit, "PAPERLESS_TOKEN=from-explicit\n");
	writeFileSync(path.join(dir, ".env"), "PAPERLESS_TOKEN=from-dir\n");
	withEnv({ PI_LOCAL_ENV: explicit, PI_LOCAL_LAUNCH_DIR: dir, PWD: dir }, () => {
		const loaded = loadLocalEnv(dir);
		assert.equal(loaded.path, explicit);
		assert.deepEqual(loaded.tried, [explicit]);
		assert.equal(process.env.PAPERLESS_TOKEN, "from-explicit");
	});
});

test("loadLocalEnv treats an empty PI_LOCAL_ENV as unset", (t) => {
	const dir = tempDir(t, "pi-local-env-empty-");
	writeFileSync(path.join(dir, ".env"), "PAPERLESS_TOKEN=from-dir\n");
	withEnv({ PI_LOCAL_ENV: "", PI_LOCAL_LAUNCH_DIR: dir, PWD: dir }, () => {
		assert.equal(loadLocalEnv(dir).path, path.join(dir, ".env"));
	});
});

test("loadLocalEnv reads nested .env when .env is a directory", (t) => {
	const dir = tempDir(t, "pi-local-env-dir-");
	mkdirSync(path.join(dir, ".env"));
	writeFileSync(path.join(dir, ".env", ".env"), "PAPERLESS_TOKEN=nested\n");
	withEnv({ PWD: dir }, () => {
		const loaded = loadLocalEnv(dir);
		assert.equal(loaded.path, path.join(dir, ".env", ".env"));
		assert.equal(process.env.PAPERLESS_TOKEN, "nested");
	});
});

test("loadLocalEnv follows a .env symlink", (t) => {
	const dir = tempDir(t, "pi-local-env-link-");
	const target = path.join(dir, "secrets.env");
	writeFileSync(target, "PAPERLESS_TOKEN=from-symlink\n");
	symlinkSync(target, path.join(dir, ".env"));
	withEnv({ PWD: dir }, () => {
		const loaded = loadLocalEnv(dir);
		// macOS tmpdir lives under a symlinked /var, so compare canonical paths.
		assert.equal(loaded.path, realpathSync(target));
		assert.equal(process.env.PAPERLESS_TOKEN, "from-symlink");
	});
});
