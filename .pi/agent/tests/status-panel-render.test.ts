import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

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

test("goal renderer keeps the full objective visible and only collapses the description", async () => {
	const script = await readFile(new URL("../extensions/status-panel.sh", import.meta.url), "utf8");
	const match = script.match(/goal_lines=\$\(echo "\$todos_json" \| python3 -c "([\s\S]*?)" "\$content_cols" "\$goal_expanded" 2>\/dev\/null\)/);
	assert.ok(match, "status-panel.sh must keep inline goal renderer block");
	const python = match[1];
	const payload = {
		goal: {
			status: "active",
			objective: "Investigate and stabilize the side panel goal rendering while preserving all stored text and avoiding regressions in existing sections",
			note: "Ensure collapsed mode stays short at narrow widths and expanded mode still shows complete details for operator context",
		},
	};

	const collapsed = spawnSync("python3", ["-c", python, "24", "0"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
	});
	assert.equal(collapsed.status, 0, collapsed.stderr || "collapsed goal python failed");
	const collapsedLines = stripAnsi(collapsed.stdout).trimEnd().split("\n");
	assert.equal(collapsedLines[0][1], "●");
	const dividerIndex = collapsedLines.indexOf("");
	assert.ok(dividerIndex > 0, "collapsed output should keep objective/note separator");
	const collapsedObjectiveLines = collapsedLines.slice(0, dividerIndex);
	assert.equal(collapsedLines[dividerIndex + 1].trim(), "Description (e: expand)");
	const collapsedNoteLines = collapsedLines.slice(dividerIndex + 2);
	assert.equal(collapsedObjectiveLines.map((line) => line.replace(/^\s*●\s*/, "").trim()).join(" "), payload.goal.objective);
	assert.equal(collapsedNoteLines.length, 2, "collapsed note should be at most two wrapped lines");
	assert.ok(collapsedNoteLines.at(-1)?.endsWith("…"), "collapsed note should end with ellipsis when truncated");

	const expanded = spawnSync("python3", ["-c", python, "24", "1"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
	});
	assert.equal(expanded.status, 0, expanded.stderr || "expanded goal python failed");
	const expandedOutput = stripAnsi(expanded.stdout);
	const expandedLines = expandedOutput.trimEnd().split("\n");
	const expandedDivider = expandedLines.indexOf("");
	assert.deepEqual(expandedLines.slice(0, expandedDivider), collapsedObjectiveLines);
	assert.equal(expandedLines[expandedDivider + 1].trim(), "Description (e: collapse)");
	assert.equal(expandedLines.slice(expandedDivider + 2).map((line) => line.trim()).join(" "), payload.goal.note);
	assert.match(expandedOutput, /Investigate and/);
	assert.match(expandedOutput, /panel goal rendering/);
	assert.match(expandedOutput, /avoiding regressions/);
	assert.match(expandedOutput, /Ensure collapsed/);
	assert.match(expandedOutput, /expanded mode still/);

	const shortGoal = spawnSync("python3", ["-c", python, "10", "0"], {
		input: JSON.stringify({ goal: { status: "paused", objective: "Short goal", note: "" } }),
		encoding: "utf8",
	});
	assert.equal(shortGoal.status, 0, shortGoal.stderr || "short goal python failed");
	const shortOutput = stripAnsi(shortGoal.stdout);
	assert.match(shortOutput, /◌ Short/);
	assert.doesNotMatch(shortOutput, /Description|e: expand|e: collapse/);
	assert.doesNotMatch(shortOutput, /\n\n\s*$/);
});

test("goal expand keyboard toggle updates state, marks rebuild, and does not change scroll position", async () => {
	const script = await readFile(new URL("../extensions/status-panel.sh", import.meta.url), "utf8");
	const funcs = script.match(/scroll_by\(\) \{[\s\S]*?\n\}\n\nhandle_input\(\) \{[\s\S]*?\n\}/);
	assert.ok(funcs, "status-panel.sh must define scroll_by and handle_input");
	const harness = `${funcs[0]}
SCROLL_OFFSET=5
MAX_SCROLL_OFFSET=50
LAST_ROWS=20
PANEL_RESIZED=0
GOAL_EXPANDED=0
handle_input e
echo "$GOAL_EXPANDED:$PANEL_RESIZED:$SCROLL_OFFSET"
handle_input e
echo "$GOAL_EXPANDED:$PANEL_RESIZED:$SCROLL_OFFSET"
`;
	const result = spawnSync("bash", ["-lc", harness], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || "handle_input harness failed");
	const [first, second] = result.stdout.trim().split("\n");
	assert.equal(first, "1:1:5");
	assert.equal(second, "0:1:5");
});

test("agent action line stays narrow, advances quiet activity age, and cannot inject shell-decoded escapes", async () => {
	const script = await readFile(new URL("../extensions/status-panel.sh", import.meta.url), "utf8");
	const python = script.match(/subagent_lines=\$\(echo "\$subagents_json" \| python3 -c "([\s\S]*?)" "\$content_cols" 2>\/dev\/null\)/)![1];
	const payload = { active: [{ agents: [{ sessionName: "Check", agentType: "coder", state: "running", model: "provider/model", thinkingLevel: "low", action: "bash test \\033]52;payload", lastActivityAt: 1000 }] }] };
	const result = spawnSync("python3", ["-c", `import time; time.time=lambda: 121\n${python}`, "44"], { input: JSON.stringify(payload), encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const lines = stripAnsi(result.stdout).trimEnd().split("\n");
	assert.equal(lines.length, 3);
	assert.match(lines[2], /activity 120s ago · bash test/);
	assert.doesNotMatch(result.stdout, /stalled|failed/);
	const decoded = spawnSync("bash", ["-c", 'printf "%b" "$1"', "bash", result.stdout], { encoding: "utf8" });
	assert.ok(stripAnsi(decoded.stdout).trimEnd().split("\n").every((line) => line.length <= 44));
	assert.doesNotMatch(decoded.stdout, /\x1b\]52/);
	assert.match(decoded.stdout, /\\033/);
});
