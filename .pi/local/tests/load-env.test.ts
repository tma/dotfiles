import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyDotEnv, loadLocalEnv, parseDotEnv } from "../extensions/lib/load-env.ts";

test("parseDotEnv handles export, quotes, and comments", () => {
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

test("loadLocalEnv reads cwd .env into process.env", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-local-env-"));
	writeFileSync(path.join(dir, ".env"), "PAPERLESS_URL=http://10.0.0.5:8000\n");
	const previous = process.env.PAPERLESS_URL;
	try {
		delete process.env.PAPERLESS_URL;
		const loaded = loadLocalEnv(dir);
		assert.equal(loaded.path, path.join(dir, ".env"));
		assert.deepEqual(loaded.keys, ["PAPERLESS_URL"]);
		assert.equal(process.env.PAPERLESS_URL, "http://10.0.0.5:8000");
	} finally {
		if (previous == null) delete process.env.PAPERLESS_URL;
		else process.env.PAPERLESS_URL = previous;
	}
});

test("applyDotEnv does not override Pi process keys", () => {
	const previous = process.env.PI_OFFLINE;
	try {
		process.env.PI_OFFLINE = "1";
		applyDotEnv("PI_OFFLINE=0\nPAPERLESS_TOKEN=abc\n");
		assert.equal(process.env.PI_OFFLINE, "1");
		assert.equal(process.env.PAPERLESS_TOKEN, "abc");
	} finally {
		if (previous == null) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previous;
		delete process.env.PAPERLESS_TOKEN;
	}
});

test("loadLocalEnv finds .env via PI_LOCAL_LAUNCH_DIR", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-local-env-launch-"));
	writeFileSync(path.join(dir, ".env"), "PAPERLESS_TOKEN=from-launch-dir\n");
	const previousLaunch = process.env.PI_LOCAL_LAUNCH_DIR;
	const previousToken = process.env.PAPERLESS_TOKEN;
	try {
		delete process.env.PAPERLESS_TOKEN;
		process.env.PI_LOCAL_LAUNCH_DIR = dir;
		const loaded = loadLocalEnv("/tmp");
		assert.equal(loaded.path, path.join(dir, ".env"));
		assert.equal(process.env.PAPERLESS_TOKEN, "from-launch-dir");
	} finally {
		if (previousLaunch == null) delete process.env.PI_LOCAL_LAUNCH_DIR;
		else process.env.PI_LOCAL_LAUNCH_DIR = previousLaunch;
		if (previousToken == null) delete process.env.PAPERLESS_TOKEN;
		else process.env.PAPERLESS_TOKEN = previousToken;
	}
});

test("loadLocalEnv reads nested .env when .env is a directory", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-local-env-dir-"));
	mkdirSync(path.join(dir, ".env"));
	writeFileSync(path.join(dir, ".env", ".env"), "PAPERLESS_TOKEN=nested\n");
	const previous = process.env.PAPERLESS_TOKEN;
	try {
		delete process.env.PAPERLESS_TOKEN;
		const loaded = loadLocalEnv(dir);
		assert.equal(loaded.path, path.join(dir, ".env", ".env"));
		assert.equal(process.env.PAPERLESS_TOKEN, "nested");
	} finally {
		if (previous == null) delete process.env.PAPERLESS_TOKEN;
		else process.env.PAPERLESS_TOKEN = previous;
	}
});

test("loadLocalEnv follows a .env symlink", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-local-env-link-"));
	const target = path.join(dir, "secrets.env");
	writeFileSync(target, "PAPERLESS_TOKEN=from-symlink\n");
	symlinkSync(target, path.join(dir, ".env"));
	const previous = process.env.PAPERLESS_TOKEN;
	try {
		delete process.env.PAPERLESS_TOKEN;
		const loaded = loadLocalEnv(dir);
		assert.equal(loaded.path, target);
		assert.equal(process.env.PAPERLESS_TOKEN, "from-symlink");
	} finally {
		if (previous == null) delete process.env.PAPERLESS_TOKEN;
		else process.env.PAPERLESS_TOKEN = previous;
	}
});
