import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("status panel embedded python keeps type/state/model/thinking visible at narrow widths and sanitizes control chars", async () => {
	const script = await readFile(new URL("../extensions/status-panel.sh", import.meta.url), "utf8");
	const match = script.match(/subagent_lines=\$\(echo "\$subagents_json" \| python3 -c "([\s\S]*?)" "\$content_cols" 2>\/dev\/null\)/);
	assert.ok(match, "status-panel.sh must keep inline python renderer block");
	const python = match[1];
	const payload = {
		active: [{
			agents: [{
				sessionName: "\u001b[31mVery Long Name\u001b[0m with \u0007control",
				agentType: "coder",
				state: "running",
				model: "provider/very-long-model-name-with-extra-words",
				thinkingLevel: "medium",
			}],
		}],
	};
	const result = spawnSync("python3", ["-c", python, "44"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || "python snippet failed");
	assert.equal(result.stderr, "");
	const output = result.stdout;
	assert.match(output, /coder/);
	assert.match(output, /running/);
	assert.match(output, /medium/);
	assert.match(output, /provider\/very-long-model-name/);
	assert.doesNotMatch(output, /\u001b\[31m|\u0007/);
});
