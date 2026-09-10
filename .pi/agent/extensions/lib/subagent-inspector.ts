import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, SessionManager } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const DETAIL_BYTES = 16 * 1024;
const LIVE_TEXT_BYTES = 4096;

export function boundedText(text: string, bytes = DETAIL_BYTES): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	const buffer = Buffer.from(text);
	let end = Math.max(0, bytes - 32);
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return `${buffer.subarray(0, end).toString("utf8")}\n[truncated]`;
}

export function boundedTail(text: string, bytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.byteLength <= bytes) return text;
	let start = Math.max(0, buffer.byteLength - bytes + 32);
	while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) start++;
	return `[truncated]\n${buffer.subarray(start).toString("utf8")}`;
}

// Render controls literally, including OSC, DCS, carriage returns and bidi overrides.
export function terminalText(text: string): string {
	return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export interface ChildInspection {
	startedAt: number;
	lastActivityAt: number;
	assistantText: string;
	tools: Array<{ id: string; name: string; args: string; startedAt: number; endedAt?: number; output: string; isError?: boolean; interrupted?: boolean }>;
}

export function newInspection(now = Date.now()): ChildInspection {
	return { startedAt: now, lastActivityAt: now, assistantText: "", tools: [] };
}

function textContent(content: any): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
}

export function trackChildEvent(live: ChildInspection, event: AgentSessionEvent, now = Date.now()): boolean {
	if (event.type === "message_update") {
		live.lastActivityAt = now;
		if (event.assistantMessageEvent.type !== "text_delta") return false;
		live.assistantText = boundedTail(live.assistantText + event.assistantMessageEvent.delta, LIVE_TEXT_BYTES);
	} else if (event.type === "message_start" || event.type === "message_end") {
		live.lastActivityAt = now;
		if (event.message.role === "assistant") live.assistantText = "";
	} else if (event.type === "tool_execution_start") {
		live.lastActivityAt = now;
		live.tools.push({ id: event.toolCallId, name: event.toolName, args: boundedText(JSON.stringify(event.args), 1024), startedAt: now, output: "" });
		// Pi may run sibling tools concurrently. Keep their IDs, not just one current tool.
		if (live.tools.length > 8) live.tools.shift();
	} else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
		live.lastActivityAt = now;
		const tool = live.tools.find((item) => item.id === event.toolCallId);
		if (tool) {
			tool.output = boundedTail(textContent(event.type === "tool_execution_end" ? event.result.content : event.partialResult.content), 512);
			if (event.type === "tool_execution_end") {
				tool.endedAt = now;
				tool.isError = event.isError;
			}
		}
	} else return false;
	return true;
}

export function finishInspection(live: ChildInspection, now = Date.now()): void {
	for (const tool of live.tools) {
		if (tool.endedAt !== undefined) continue;
		tool.endedAt = now;
		tool.interrupted = true;
	}
}

function age(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export function inspectionActivity(live: ChildInspection, now = Date.now()): string {
	const active = live.tools.filter((tool) => tool.endedAt === undefined);
	const tool = active[0] ?? live.tools.at(-1);
	const action = tool ? `${tool.name} · ${age((tool.endedAt ?? now) - tool.startedAt)}${tool.endedAt === undefined ? " running" : tool.interrupted ? " interrupted" : tool.isError ? " error" : " done"}` : "awaiting output";
	return `${action}${active.length > 1 ? ` (+${active.length - 1} tools)` : ""} · activity ${age(now - live.lastActivityAt)} ago${tool ? ` · ${tool.args.replace(/\s+/g, " ")}` : ""}`;
}

export interface InspectableChild {
	sessionName: string;
	agentType: string;
	task: string;
	state: string;
	model?: string;
	thinkingLevel?: string;
	selectionReason?: string;
	durationMs?: number;
	errorMessage?: string;
	sessionFile?: string;
	sessionSaved?: boolean;
	persistenceError?: string;
	inspection?: ChildInspection;
	messages: any[];
}

export function childDetail(child: InspectableChild, now = Date.now()): string {
	const live = child.inspection;
	const lines = [
		`${child.sessionName} [${child.agentType}]`,
		`${child.model ?? "model pending"} · thinking ${child.thinkingLevel ?? "pending"}`,
		`state: ${child.state} · elapsed ${age(child.durationMs ?? (live ? now - live.startedAt : 0))}`,
		`selection: ${child.selectionReason ?? "pending"}`,
		`native session (${child.sessionSaved ? "file exists; read-only" : "pending; no saved transcript yet"}): ${child.sessionFile ?? "not allocated"}`,
	];
	if (child.persistenceError) lines.push(`PERSISTENCE ERROR: ${child.persistenceError}`);
	if (child.errorMessage) lines.push(`error: ${child.errorMessage}`);
	if (live) {
		lines.push(`last activity: ${age(now - live.lastActivityAt)} ago (quiet does not mean stalled)`);
		for (const tool of live.tools) {
			lines.push(`\n${tool.name} · ${age((tool.endedAt ?? now) - tool.startedAt)} · ${tool.endedAt === undefined ? "running" : tool.interrupted ? "interrupted" : tool.isError ? "error" : "done"}`, tool.args);
			if (tool.output) lines.push(tool.output);
		}
	}
	lines.push("\nTask:", child.task, "\nRecent transcript (bounded; older/full content is in the native session):");
	for (const message of child.messages) {
		lines.push(`[${message.role}${message.toolName ? ` ${message.toolName}` : ""}]`);
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "toolCall") lines.push(`${part.name} ${JSON.stringify(part.arguments, null, 2)}`);
			}
		}
		lines.push(textContent(message.content));
	}
	if (live?.assistantText) lines.push("[assistant streaming]", live.assistantText);
	return terminalText(lines.join("\n"));
}

function detailChunk(text: string, offset = 0): { text: string; nextOffset?: number } {
	if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new Error(`Invalid detail offset ${offset}; range 0..${text.length}`);
	const page = boundedText(text.slice(offset), DETAIL_BYTES - 256);
	const truncated = page !== text.slice(offset);
	const consumed = truncated ? page.length - "\n[truncated]".length : page.length;
	const nextOffset = truncated ? offset + consumed : undefined;
	return {
		text: `${page}\n\n[detail offset ${offset}; ${nextOffset !== undefined ? `next offset ${nextOffset}` : "end"}; native session contains full transcript]`,
		nextOffset,
	};
}

export function detailPage(text: string, offset = 0): string {
	return detailChunk(text, offset).text;
}

export function childSessionDir(cwd: string, ownerId: string, ownerFile?: string): string {
	const key = createHash("sha256").update(JSON.stringify([ownerId, ownerFile ?? null])).digest("hex");
	const directory = path.join(os.homedir(), ".local", "state", "pi", "subagent-sessions", key);
	let existing = directory;
	while (!fs.existsSync(existing)) existing = path.dirname(existing);
	const resolved = path.resolve(fs.realpathSync(existing), path.relative(existing, directory));
	const relative = path.relative(fs.realpathSync(cwd), resolved);
	if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
		throw new Error(`Child session storage must be outside the workspace: ${directory}`);
	}
	return directory;
}

export function createChildSession(cwd: string, ownerId: string, ownerFile?: string): SessionManager {
	const directory = childSessionDir(cwd, ownerId, ownerFile);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	const manager = SessionManager.create(cwd, directory);
	const file = manager.getSessionFile();
	if (!file) throw new Error("Pi did not allocate a persistent child session path");
	// Pi writes this path on the first assistant message, not at allocation.
	return manager;
}

export async function savedChildSessions(cwd: string, ownerId: string, ownerFile?: string): Promise<string> {
	const directory = childSessionDir(cwd, ownerId, ownerFile);
	const sessions = await SessionManager.list(cwd, directory);
	return terminalText(`Native child sessions (read-only paths; no live handles restored):\n${directory}\n\n${sessions.map((session) => `${session.name ?? session.id}\n${session.path}`).join("\n\n") || "No saved transcripts. Pi creates files after the first assistant message."}\n\nInspect JSONL as data; do not open a live child with pi --session.`);
}

export interface InspectorItem {
	id: string;
	index: number;
	label: string;
	detail: () => string;
	readOnly?: boolean;
}

export type InspectorAction = { action: "steer" | "followUp" | "stop"; id: string; index: number };

export async function showInspector(
	ctx: ExtensionContext,
	items: () => InspectorItem[],
	signal: AbortSignal,
): Promise<InspectorAction | undefined> {
	if (ctx.mode !== "tui") throw new Error("/agents requires TUI mode; use subagent action=status for model-facing detail");
	if (signal.aborted) return;
	let cleanup = () => {};
	try {
		return await ctx.ui.custom<InspectorAction | undefined>((tui, theme, keys, done) => {
			let selected: InspectorItem | undefined;
			let offset = 0;
			let pageSize = 1;
			let textOffset = 0;
			let nextTextOffset = 0;
			let maxOffset = 0;
			let closed = false;
			let fingerprint = "";
			let list: SelectList;
			let current: InspectorItem[] = [];
			const close = (value?: InspectorAction) => { if (!closed) { dispose(); done(value); } };
			const onAbort = () => close();
			const timer = setInterval(() => tui.requestRender(), 500);
			const dispose = () => {
				closed = true;
				clearInterval(timer);
				signal.removeEventListener("abort", onAbort);
			};
			cleanup = dispose;
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) queueMicrotask(onAbort);
			return {
				dispose,
				invalidate() { fingerprint = ""; },
				render(width) {
					const paddingX = 2;
					const contentWidth = Math.max(1, width - paddingX * 2);
					pageSize = Math.max(1, Math.min(30, tui.terminal.rows - 10));
					const fresh = items();
					const next = JSON.stringify([pageSize, fresh.map((item) => [item.id, item.index, item.label])]);
					if (next !== fingerprint || !list) {
						const previous = list?.getSelectedItem()?.value;
						current = fresh;
						list = new SelectList(current.map((item) => ({ value: `${item.id}:${item.index}`, label: terminalText(item.label) })), pageSize, {
							selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
						});
						const index = current.findIndex((item) => `${item.id}:${item.index}` === previous);
						if (index >= 0) list.setSelectedIndex(index);
						list.onSelect = (item) => { selected = current.find((entry) => `${entry.id}:${entry.index}` === item.value); offset = 0; textOffset = 0; };
						fingerprint = next;
					}
					let body: string[];
					if (selected) {
						const text = fresh.find((item) => item.id === selected!.id && item.index === selected!.index)?.detail() ?? "Child is no longer retained.";
						textOffset = Math.min(textOffset, text.length);
						const page = detailChunk(text, textOffset);
						nextTextOffset = page.nextOffset ?? textOffset;
						const lines = wrapTextWithAnsi(terminalText(page.text), contentWidth);
						maxOffset = Math.max(0, lines.length - pageSize);
						offset = Math.min(offset, maxOffset);
						body = lines.slice(offset, offset + pageSize);
					} else body = current.length ? list.render(contentWidth).slice(0, pageSize) : ["No jobs in this session. /agents saved lists native session paths."];
					const content = [theme.fg("accent", "Agents · read-only inspector"), ...body,
						theme.fg("dim", selected?.readOnly ? "↑↓/PgUp/PgDn · Home/End · ] next page · [ first · Esc back" : selected ? "↑↓/PgUp/PgDn · Home/End · ] next page · [ first · s steer · f follow-up · x stop job · Esc back" : "↑↓ select child · Enter inspect · Esc close"),
					].map((line) => truncateToWidth(line, contentWidth));
					const panel = new Box(paddingX, 1);
					panel.addChild({ render: () => content, invalidate() {} });
					const border = new DynamicBorder((text: string) => theme.fg("accent", text));
					return [...border.render(width), ...panel.render(width), ...border.render(width)]
						.map((line) => truncateToWidth(line, width));
				},
				handleInput(data) {
					if (keys.matches(data, "tui.select.cancel")) {
						if (selected) selected = undefined;
						else close();
					} else if (!selected) list?.handleInput(data);
					else if (!selected.readOnly && ["s", "f", "x"].includes(data)) close({ action: data === "s" ? "steer" : data === "f" ? "followUp" : "stop", id: selected.id, index: selected.index });
					else if (keys.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
					else if (keys.matches(data, "tui.select.down")) offset = Math.min(maxOffset, offset + 1);
					else if (keys.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - pageSize);
					else if (keys.matches(data, "tui.select.pageDown")) offset = Math.min(maxOffset, offset + pageSize);
					else if (data === "]") { textOffset = nextTextOffset; offset = 0; }
					else if (data === "[") { textOffset = 0; offset = 0; }
					else if (matchesKey(data, "home")) offset = 0;
					else if (matchesKey(data, "end")) offset = maxOffset;
					tui.requestRender();
				},
			};
		});
	} finally {
		cleanup();
	}
}
