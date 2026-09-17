import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
