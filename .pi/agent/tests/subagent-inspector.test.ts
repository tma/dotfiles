import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspector, loadInspector } from "./helpers/subagent-inspector.ts";

const text = (value: string) => [{ type: "text", text: value }];

test("tracks streaming text, parallel tools, partial results, durations and quiet activity without reasoning", () => {
	const live = inspector.newInspection(1000);
	inspector.trackChildEvent(live, { type: "message_update", message: { content: [{ type: "thinking", thinking: "private reasoning" }] }, assistantMessageEvent: { type: "thinking_delta" } }, 2000);
	assert.equal(live.assistantText, "");
	inspector.trackChildEvent(live, { type: "message_update", message: { content: text("Inspecting files") }, assistantMessageEvent: { type: "text_delta", delta: "Inspecting files" } }, 3000);
	assert.equal(live.assistantText, "Inspecting files");
	for (const id of ["a", "b"]) inspector.trackChildEvent(live, { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: `cat /workspace/${id}.ts` } }, 4000);
	inspector.trackChildEvent(live, { type: "tool_execution_update", toolCallId: "a", partialResult: { content: text("partial") } }, 5000);
	inspector.trackChildEvent(live, { type: "tool_execution_end", toolCallId: "b", result: { content: text("done") }, isError: false }, 6000);
	assert.equal(live.tools[0].output, "partial");
	assert.equal(live.tools[0].endedAt, undefined);
	assert.equal(live.tools[1].endedAt, 6000);
	const quiet = inspector.inspectionActivity(live, 126000);
	assert.match(quiet, /bash · 2m2s running · activity 2m0s ago/);
	assert.match(quiet, /cat \/workspace\/a.ts/);
	assert.doesNotMatch(quiet, /failed|stalled/);
	for (let i = 0; i < 100; i++) {
		inspector.trackChildEvent(live, { type: "tool_execution_start", toolCallId: `${i}`, toolName: "write", args: { content: "火".repeat(5000) } });
		inspector.trackChildEvent(live, { type: "tool_execution_update", toolCallId: `${i}`, partialResult: { content: text("火".repeat(5000)) } });
	}
	inspector.trackChildEvent(live, { type: "message_update", message: { content: text("火".repeat(5000)) }, assistantMessageEvent: { type: "text_delta", delta: "火".repeat(5000) } });
	assert.equal(live.tools.length, 8);
	assert.ok(Buffer.byteLength(JSON.stringify(live)) < 20 * 1024);
	assert.doesNotMatch(JSON.stringify(live), /private reasoning|�/);
});

test("detail includes task, identity, arguments and tool results; pages are bounded and terminal-safe", () => {
	const unsafe = "\x1b]52;c;payload\x07\x1bPdata\x1b\\\x9b2J\r\b\u202esecret";
	const detail = inspector.childDetail({
		sessionName: unsafe, agentType: "coder", model: "provider/model", thinkingLevel: "low", state: "running",
		task: `Full task\n${"火".repeat(20_000)}`, sessionFile: "/tmp/native.jsonl", sessionSaved: false,
		messages: [
			{ role: "assistant", content: [{ type: "thinking", thinking: "HIDDEN" }, { type: "toolCall", name: "read", arguments: { path: "/workspace/real.ts", offset: 42 } }] },
			{ role: "toolResult", toolName: "read", content: text(`exact tool output ${unsafe}`) },
		],
	});
	assert.match(detail, /pending; no saved transcript yet/);
	assert.match(detail, /thinking low/);
	assert.doesNotMatch(detail, /HIDDEN|[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/);
	assert.match(detail, /\\u001b/);
	let offset = 0;
	let combined = "";
	for (let page = 0; page < 20; page++) {
		const output = inspector.detailPage(detail, offset);
		assert.ok(Buffer.byteLength(output) <= 16 * 1024);
		assert.doesNotMatch(output, /�/);
		combined += output;
		const next = output.match(/next offset (\d+)/);
		if (!next) break;
		assert.ok(Number(next[1]) > offset);
		offset = Number(next[1]);
	}
	assert.match(combined, /Full task/);
	assert.match(combined, /\/workspace\/real.ts/);
	assert.match(combined, /exact tool output/);
	for (const offset of [-1, 1.5, NaN, detail.length + 1]) assert.throws(() => inspector.detailPage(detail, offset), /Invalid detail offset/);
});

test("native storage is external, owner-scoped, private, and allocated only by SessionManager.create", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pi-inspector-home-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const calls: any[] = [];
	const sdk = { create: (cwd: string, directory: string) => { calls.push([cwd, directory]); return { getSessionFile: () => join(directory, "native.jsonl") }; }, list: async (_cwd: string, directory: string) => [{ id: "native", path: join(directory, "native.jsonl") }] };
	const module = loadInspector({ os: { homedir: () => home }, SessionManager: sdk });
	const first = module.createChildSession("/workspace", "owner", "/tmp/parent.jsonl");
	assert.match(first.getSessionFile(), /\.local\/state\/pi\/subagent-sessions\/[a-f0-9]{64}\/native.jsonl$/);
	assert.equal((await stat(calls[0][1])).mode & 0o777, 0o700);
	await assert.rejects(stat(first.getSessionFile()), /ENOENT/);
	assert.equal(calls[0][0], "/workspace");
	assert.notEqual(module.childSessionDir("/workspace", "other", "/tmp/parent.jsonl"), calls[0][1]);
	assert.notEqual(module.childSessionDir("/workspace", "owner", "/tmp/other.jsonl"), calls[0][1]);
	assert.match(await module.savedChildSessions("/workspace", "owner", "/tmp/parent.jsonl"), /no live handles restored/);
	assert.throws(() => module.childSessionDir(home, "owner"), /outside the workspace/);
	const broken = loadInspector({ os: { homedir: () => home }, SessionManager: { create: () => { throw new Error("disk unavailable"); } } });
	assert.throws(() => broken.createChildSession("/workspace", "owner"), /disk unavailable/);
});

function uiFixture() {
	let tick: (() => void) | undefined;
	let component: any;
	let renders = 0;
	let customOptions: any;
	const module = loadInspector({ setInterval: (cb: () => void) => { tick = cb; return 1; }, clearInterval: () => { tick = undefined; } });
	const ctx = { mode: "tui", ui: { custom: (factory: any, options?: any) => {
		customOptions = options;
		return new Promise((resolve) => {
			component = factory({ requestRender: () => { renders++; }, terminal: { rows: 20 } }, { fg: (_: string, value: string) => value },
				{ matches: (value: string, key: string) => value === key.split(".").at(-1)?.replace("confirm", "enter").replace("cancel", "escape") }, resolve);
		});
	} } };
	return { module, ctx, component: () => component, tick: () => tick?.(), hasTimer: () => Boolean(tick), renders: () => renders, options: () => customOptions };
}

test("inspector uses the editor area with padding and borders in list and detail views", async () => {
	const ui = uiFixture();
	const controller = new AbortController();
	const opened = ui.module.showInspector(ui.ctx, () => [{
		id: "job", index: 0, label: "Child", detail: () => "output ".repeat(200),
	}], controller.signal);
	try {
		assert.equal(ui.options()?.overlay, undefined);
		const component = ui.component();
		for (const view of ["list", "detail"]) {
			if (view === "detail") component.handleInput("enter");
			for (const width of [60, 20, 6]) {
				const lines = component.render(width);
				assert.equal(lines[0], "─".repeat(width));
				assert.equal(lines.at(-1), "─".repeat(width));
				assert.equal(lines[1], " ".repeat(width));
				assert.equal(lines.at(-2), " ".repeat(width));
				assert.ok(lines.slice(2, -2).every((line: string) => line.startsWith("  ") && line.endsWith("  ")));
				assert.ok(lines.every((line: string) => [...line].length <= width));
				assert.ok(lines.length <= 20);
			}
		}
	} finally {
		controller.abort();
		await opened;
	}
});

for (const close of ["escape", "abort"]) test(`inspector is scrollable, bounded and cleans its timer on ${close}`, async () => {
	const ui = uiFixture();
	const controller = new AbortController();
	const opened = ui.module.showInspector(ui.ctx, () => [{ id: "job", index: 1, label: "Child\x07", detail: () => "full task\n" + "long output\n".repeat(200) }], controller.signal);
	const component = ui.component();
	component.render(20);
	component.handleInput("enter");
	const before = component.render(20);
	assert.ok(before.every((line: string) => [...line].length <= 20));
	component.handleInput("pageDown");
	assert.notDeepEqual(component.render(20), before);
	ui.tick();
	assert.ok(ui.renders() > 0);
	if (close === "abort") controller.abort();
	else { component.handleInput("escape"); component.handleInput("escape"); }
	assert.equal(await opened, undefined);
	assert.equal(ui.hasTimer(), false);
	component.dispose();
});

test("inspector paging ignores navigation-like text in child output", async () => {
	const ui = uiFixture();
	const controller = new AbortController();
	const opened = ui.module.showInspector(ui.ctx, () => [{
		id: "job", index: 0, label: "child",
		detail: () => "next offset 1\n" + "x".repeat(20_000) + "\nFINAL OUTPUT",
	}], controller.signal);
	const component = ui.component();
	component.render(80);
	component.handleInput("enter");
	component.render(80);
	component.handleInput("]");
	component.render(80);
	component.handleInput("end");
	assert.match(component.render(80).join("\n"), /FINAL OUTPUT/);
	controller.abort();
	await opened;
	assert.equal(ui.hasTimer(), false);
});

test("inspector returns only a selected control request and disposes before command dialogs", async () => {
	const ui = uiFixture();
	const controller = new AbortController();
	const opened = ui.module.showInspector(ui.ctx, () => [{ id: "job", index: 2, label: "child", detail: () => "text" }], controller.signal);
	ui.component().render(60);
	ui.component().handleInput("enter");
	ui.component().handleInput("s");
	assert.deepEqual(await opened, { action: "steer", id: "job", index: 2 });
	assert.equal(ui.hasTimer(), false);
	await assert.rejects(ui.module.showInspector({ mode: "rpc" }, () => [], controller.signal), /requires TUI/);
});

test("live assistant and tool tails retain final progress after a large multibyte prefix", () => {
	const live = inspector.newInspection(1000);
	const prefix = "火".repeat(10_000);
	inspector.trackChildEvent(live, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: prefix } });
	inspector.trackChildEvent(live, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "LATEST ASSISTANT" } });
	inspector.trackChildEvent(live, { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "test" } });
	inspector.trackChildEvent(live, { type: "tool_execution_update", toolCallId: "call", partialResult: { content: text(prefix + "LATEST TOOL") } });
	assert.ok(Buffer.byteLength(live.assistantText) <= 4096);
	assert.ok(Buffer.byteLength(live.tools[0].output) <= 512);
	assert.ok(live.assistantText.endsWith("LATEST ASSISTANT"));
	assert.ok(live.tools[0].output.endsWith("LATEST TOOL"));
	assert.doesNotMatch(live.assistantText + live.tools[0].output, /�/);
});

for (const state of ["aborted", "failed"]) test(`${state} child freezes unfinished tools as interrupted, not successful`, () => {
	const live = inspector.newInspection(1000);
	for (const id of ["ok", "error", "unfinished"]) inspector.trackChildEvent(live, { type: "tool_execution_start", toolCallId: id, toolName: id, args: {} }, 1000);
	for (const id of ["ok", "error"]) inspector.trackChildEvent(live, { type: "tool_execution_end", toolCallId: id, result: { content: text("result") }, isError: id === "error" }, 2000);
	inspector.finishInspection(live, 4000);
	assert.equal(live.tools[2].interrupted, true);
	const detail = inspector.childDetail({ sessionName: "task", agentType: "coder", state, task: "task", messages: [], inspection: live, durationMs: 3000 }, 9000);
	assert.match(detail, /ok · 1s · done/);
	assert.match(detail, /error · 1s · error/);
	assert.match(detail, /unfinished · 3s · interrupted/);
	assert.match(inspector.inspectionActivity(live, 9000), /unfinished · 3s interrupted/);
});
