/**
 * Pi Notify Extension
 *
 * Sends one notification per settled run, led by its outcome, using OSC 777,
 * OSC 99, or a Windows toast. Also writes session stats for the status panel.
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AssistantMessageLike,
	completionPreview,
	escapePowerShellSingleQuoted,
	sanitizeNotificationText,
} from "./lib/notification-preview.js";

const attentionNotificationEvent = "notify:attention";

interface AttentionNotification {
	title: string;
	body: string;
}

// ── stats file for status panel ──────────────────────────────────────────────

let statsFile = "";

function getStateDir(sessionFile: string | undefined): string {
	if (sessionFile) {
		return path.dirname(sessionFile);
	}

	const ephemeralDir = path.join(os.tmpdir(), `pi-session-${process.pid}`);
	try {
		mkdirSync(ephemeralDir, { recursive: true });
	} catch {}
	return ephemeralDir;
}

interface SessionStats {
	model: string;
	thinkingLevel: string;
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	errors: number;
	state: "idle" | "working" | "error";
	filesEdited: string[];
	filesCreated: string[];
	commandsRun: number;
	sessionName: string;
	subagent: {
		mode: "single" | "parallel" | "chain" | null;
		agents: string[];
		completed: number;
		total: number;
	} | null;
	updatedAt: number;
}

function writeStats(stats: SessionStats): void {
	if (!statsFile) return;
	try {
		writeFileSync(statsFile, JSON.stringify(stats), "utf-8");
	} catch {}
}

// ── generic terminal notifications ───────────────────────────────────────────

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	title = escapePowerShellSingleQuoted(title);
	body = escapePowerShellSingleQuoted(body);
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	const script = [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
	execFile("powershell.exe", ["-NoProfile", "-Command", script]);
}

function notify(title: string, body: string): void {
	title = singleLine(title);
	body = singleLine(body);
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Strips terminal controls and line breaks; callers bound length themselves. */
function singleLine(text: string): string {
	return sanitizeNotificationText(text, Number.POSITIVE_INFINITY);
}

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

// ── extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const disableChildUi = ["1", "true", "yes"].includes(process.env.PI_DISABLE_MUX_UI?.toLowerCase() ?? "");
	if (disableChildUi) return;

	pi.events.on(attentionNotificationEvent, (event: AttentionNotification) => {
		notify(event.title, event.body);
	});

	let errorsThisLoop = 0;
	let currentModel = "";
	let filesEdited = new Set<string>();
	let filesCreated = new Set<string>();
	let commandsRun = 0;

	let activeSubagents = 0;
	let completedSubagents = 0;
	let subagentTaskList: Array<{ agent: string; task: string }> = [];
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let totalTurns = 0;
	let agentState: "idle" | "working" | "error" = "idle";
	let subagentInfo: SessionStats["subagent"] = null;
	let currentCtx: { getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined } | null = null;
	let sessionName = "";

	// One settled run can span several low-level agent runs (retries, compaction, queued follow-ups).
	let runPending = false;
	let lastAssistantMessage: AssistantMessageLike | undefined;

	function resetPendingRun(): void {
		runPending = false;
		lastAssistantMessage = undefined;
	}

	function flushStats(): void {
		const usage = currentCtx?.getContextUsage?.();
		writeStats({
			model: currentModel,
			thinkingLevel: pi.getThinkingLevel(),
			contextTokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? 0,
			contextPercent: usage?.percent ?? null,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			cost: totalCost,
			turns: totalTurns,
			errors: errorsThisLoop,
			state: agentState,
			filesEdited: [...filesEdited],
			filesCreated: [...filesCreated],
			commandsRun,
			sessionName,
			subagent: subagentInfo,
			updatedAt: Date.now(),
		});
	}

	// ── session lifecycle ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		resetPendingRun();
		currentCtx = ctx;
		const sessionDir = getStateDir(ctx.sessionManager.getSessionFile());
		statsFile = path.join(sessionDir, `${process.pid}-stats.json`);
		currentModel = ctx.model?.name ?? "";
		totalInputTokens = 0;
		totalOutputTokens = 0;
		totalCacheRead = 0;
		totalCacheWrite = 0;
		totalCost = 0;
		totalTurns = 0;
		filesEdited = new Set();
		filesCreated = new Set();
		commandsRun = 0;
		agentState = "idle";
		subagentInfo = null;
		sessionName = pi.getSessionName() ?? "";

		// Bootstrap from existing session entries (matches Pi's footer logic)
		for (const entry of ctx.sessionManager.getEntries()) {
			if ((entry as any).type === "message" && (entry as any).message?.role === "assistant") {
				const u = (entry as any).message.usage;
				if (u) {
					totalInputTokens += u.input || 0;
					totalOutputTokens += u.output || 0;
					totalCacheRead += u.cacheRead || 0;
					totalCacheWrite += u.cacheWrite || 0;
					totalCost += u.cost?.total || 0;
					totalTurns++;
				}
			}
		}

		flushStats();
	});

	pi.on("session_info_changed", async (event) => {
		sessionName = event.name ?? "";
		flushStats();
	});

	pi.on("session_shutdown", async () => {
		resetPendingRun();
		agentState = "idle";
		flushStats();
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetPendingRun();
		currentCtx = ctx;
		const sessionDir = getStateDir(ctx.sessionManager.getSessionFile());
		statsFile = path.join(sessionDir, `${process.pid}-stats.json`);
		currentModel = ctx.model?.name ?? "";
		totalInputTokens = 0;
		totalOutputTokens = 0;
		totalCacheRead = 0;
		totalCacheWrite = 0;
		totalCost = 0;
		totalTurns = 0;
		filesEdited = new Set();
		filesCreated = new Set();
		commandsRun = 0;
		errorsThisLoop = 0;
		agentState = "idle";
		subagentInfo = null;
		sessionName = pi.getSessionName() ?? "";

		// Bootstrap from existing session entries
		for (const entry of ctx.sessionManager.getEntries()) {
			if ((entry as any).type === "message" && (entry as any).message?.role === "assistant") {
				const u = (entry as any).message.usage;
				if (u) {
					totalInputTokens += u.input || 0;
					totalOutputTokens += u.output || 0;
					totalCacheRead += u.cacheRead || 0;
					totalCacheWrite += u.cacheWrite || 0;
					totalCost += u.cost?.total || 0;
					totalTurns++;
				}
			}
		}

		flushStats();
	});

	// ── model changes ────────────────────────────────────────────────────

	pi.on("model_select", async (event) => {
		currentModel = event.model.name;
		flushStats();
	});

	pi.on("thinking_level_select", async () => {
		flushStats();
	});

	// ── agent loop ───────────────────────────────────────────────────────

	pi.on("agent_start", async () => {
		runPending = true;
		lastAssistantMessage = undefined;
		errorsThisLoop = 0;
		activeSubagents = 0;
		completedSubagents = 0;
		agentState = "working";
		subagentInfo = null;
		subagentTaskList = [];
		flushStats();
	});

	pi.on("agent_end", async (_event) => {
		agentState = "idle";
		subagentInfo = null;
		flushStats();
	});

	// agent_end can be followed by a retry, compaction, or queued follow-up.
	// Notify once Pi will not continue on its own.
	pi.on("agent_settled", async () => {
		if (!runPending) return;
		const body = completionPreview(lastAssistantMessage);
		resetPendingRun();
		notify("Pi", body);
	});

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (msg.role === "assistant") {
			lastAssistantMessage = msg as AssistantMessageLike;
			totalTurns++;
			const u = (msg as any).usage;
			if (u) {
				totalInputTokens += u.input || 0;
				totalOutputTokens += u.output || 0;
				totalCacheRead += u.cacheRead || 0;
				totalCacheWrite += u.cacheWrite || 0;
				totalCost += u.cost?.total || 0;
			}
			flushStats();
		}
	});

	// ── tool execution ───────────────────────────────────────────────────

	pi.on("tool_execution_start", async (event) => {
		const name = event.toolName;

		if (name === "subagent") {
			const args = event.args ?? {};
			if (args.chain?.length) {
				subagentTaskList = args.chain.map((s: any) => ({ agent: s.agent, task: s.task }));
			} else if (args.tasks?.length) {
				subagentTaskList = args.tasks.map((t: any) => ({ agent: t.agent, task: t.task }));
			} else if (args.agent) {
				subagentTaskList = [{ agent: args.agent, task: args.task }];
			}

			if (args.chain?.length) {
				activeSubagents = args.chain.length;
				completedSubagents = 0;
				subagentInfo = { mode: "chain", agents: args.chain.map((s: any) => s.agent), completed: 0, total: activeSubagents };
			} else if (args.tasks?.length) {
				activeSubagents = args.tasks.length;
				completedSubagents = 0;
				subagentInfo = { mode: "parallel", agents: args.tasks.map((t: any) => t.agent), completed: 0, total: activeSubagents };
			} else if (args.agent) {
				activeSubagents = 1;
				completedSubagents = 0;
				subagentInfo = { mode: "single", agents: [args.agent], completed: 0, total: 1 };
			}
			flushStats();
		} else if (name === "bash") {
			commandsRun++;
		} else if (name === "edit") {
			const epath = String(event.args?.path ?? "");
			filesEdited.add(basename(epath));
		} else if (name === "write") {
			const wpath = String(event.args?.path ?? "");
			filesCreated.add(basename(wpath));
		}
		flushStats();
	});

	// ── subagent progress tracking ───────────────────────────────────────

	pi.on("tool_execution_update", async (event) => {
		if (event.toolName !== "subagent") return;
		const details = event.partialResult?.details;
		if (!details?.results) return;

		const results = details.results as Array<{ agent: string; exitCode: number }>;
		const done = results.filter((r) => r.exitCode !== -1).length;
		if (done <= completedSubagents) return;

		completedSubagents = done;
		if ((details.mode === "chain" || details.mode === "parallel") && subagentInfo) {
			subagentInfo.completed = done;
		}

		flushStats();
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.isError) {
			errorsThisLoop++;
		}

		if (event.toolName === "subagent") {
			activeSubagents = 0;
			completedSubagents = 0;
			subagentTaskList = [];
			subagentInfo = null;
			flushStats();
		}
	});
}
