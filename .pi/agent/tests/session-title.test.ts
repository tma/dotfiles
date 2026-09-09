import assert from "node:assert/strict";
import test from "node:test";
import { cleanGeneratedSessionName } from "../extensions/lib/session-title.ts";

test("cleanGeneratedSessionName uses the first non-empty line before sanitizing", () => {
	assert.equal(cleanGeneratedSessionName("\nFirst line\nSecond line"), "First Line");
	assert.equal(cleanGeneratedSessionName("Title: Keep first\nDrop second"), "Keep First");
});
