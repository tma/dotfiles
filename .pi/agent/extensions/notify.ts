/**
 * Pi Notify Extension — full cmux integration
 *
 * Maps Pi lifecycle events to cmux sidebar metadata:
 * - Status pills with icons/colors for agent state
 * - Progress bar tracking turns within an agent loop
 * - Sidebar log entries for tool calls, errors, compaction
 * - Rich notifications for completion and errors
 *
 * Falls back to OSC 777/99/Windows toast when not in cmux.
 */

import { execFile } from "node:child_process";
import { accessSync, writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── cmux detection ───────────────────────────────────────────────────────────

let _cmuxAvailable: boolean | null = null;

function isCmux(): boolean {
	if (_cmuxAvailable !== null) return _cmuxAvailable;
	_cmuxAvailable = detectCmux();
	return _cmuxAvailable;
}

function detectCmux(): boolean {
	if (process.env.CMUX_WORKSPACE_ID) return true;
	try {
		const sockPath = process.env.CMUX_SOCKET_PATH
			?? `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`;
		accessSync(sockPath);
		return true;
	} catch {
		return false;
	}
}

function resetCmuxDetection(): void {
	_cmuxAvailable = null;
}

// ── stats file for status panel ──────────────────────────────────────────────

const STATS_DIR = path.join(os.tmpdir(), "pi-status");

function getStatsFile(cwd: string): string {
	const safeName = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
	return path.join(STATS_DIR, `${safeName}-${process.pid}.json`);
}

let statsFile = "";

interface SessionStats {
	model: string;
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
		mkdirSync(STATS_DIR, { recursive: true });
		writeFileSync(statsFile, JSON.stringify(stats), "utf-8");
	} catch {}
}

// ── cmux commands ────────────────────────────────────────────────────────────

function cmux(args: string[]): void {
	if (!isCmux()) return;
	execFile("cmux", args, { timeout: 3000 }, () => {});
}

function cmuxNotify(title: string, body: string, subtitle?: string): void {
	const args = ["notify", "--title", title, "--body", body];
	if (subtitle) args.push("--subtitle", subtitle);
	cmux(args);
}

function cmuxSetStatus(key: string, value: string, icon?: string, color?: string): void {
	const args = ["set-status", key, value];
	if (icon) args.push("--icon", icon);
	if (color) args.push("--color", color);
	cmux(args);
}

function cmuxClearStatus(key: string): void {
	cmux(["clear-status", key]);
}

function cmuxLog(message: string, level: string = "info"): void {
	cmux(["log", "--level", level, "--source", "pi", "--", message]);
}

function cmuxSetProgress(value: number, label?: string): void {
	const args = ["set-progress", String(Math.min(1, Math.max(0, value)))];
	if (label) args.push("--label", label);
	cmux(args);
}

function cmuxClearProgress(): void {
	cmux(["clear-progress"]);
}

function cmuxClearLog(): void {
	cmux(["clear-log"]);
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

function notify(title: string, body: string, subtitle?: string): void {
	if (isCmux()) {
		cmuxNotify(title, body, subtitle);
	} else if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

function listFiles(files: Set<string>, limit: number = 3): string {
	const arr = [...files];
	if (arr.length <= limit) return arr.join(", ");
	return `${arr.slice(0, limit).join(", ")} +${arr.length - limit} more`;
}

// ── extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let turnCount = 0;
	let toolsThisTurn = 0;
	let errorsThisLoop = 0;
	let startTime = 0;
	let currentModel = "";
	let filesEdited = new Set<string>();
	let filesCreated = new Set<string>();
	let commandsRun = 0;

	let activeSubagents = 0;
	let completedSubagents = 0;
	let loggedSubagents = new Set<string>();
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let totalTurns = 0;
	let agentState: "idle" | "working" | "error" = "idle";
	let subagentInfo: SessionStats["subagent"] = null;
	let currentCtx: { getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined } | null = null;

	function flushStats(): void {
		const usage = currentCtx?.getContextUsage?.();
		writeStats({
			model: currentModel,
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
			subagent: subagentInfo,
			updatedAt: Date.now(),
		});
	}

	function buildSummary(elapsed: string): string {
		const parts: string[] = [];
		const edited = filesEdited.size;
		const created = filesCreated.size;
		const noTools = edited === 0 && created === 0 && commandsRun === 0;

		if (noTools) {
			// Pure conversation — no file changes, no commands
			return `Responded (${elapsed}s)`;
		}

		// File mutations
		if (created > 0 && edited > 0) {
			parts.push(`Created ${listFiles(filesCreated)}, edited ${listFiles(filesEdited)}`);
		} else if (created > 0) {
			parts.push(`Created ${listFiles(filesCreated)}`);
		} else if (edited > 0) {
			parts.push(`Edited ${listFiles(filesEdited)}`);
		}

		// Commands
		if (commandsRun > 0) {
			parts.push(`ran ${commandsRun} command${commandsRun !== 1 ? "s" : ""}`);
		}

		return `${parts.join(", ")} (${elapsed}s)`;
	}

	// ── session lifecycle ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		resetCmuxDetection();
		currentCtx = ctx;
		statsFile = getStatsFile(ctx.cwd);
		cmuxClearLog();
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

		cmuxLog(`Session started${currentModel ? ` (${currentModel})` : ""}`);
		cmuxSetStatus("pi", "idle", "terminal.fill", "#8e8e93");
		flushStats();
	});

	pi.on("session_shutdown", async () => {
		cmuxClearStatus("pi");
		cmuxClearProgress();
		cmuxLog("Session ended");
		agentState = "idle";
		flushStats();
	});

	pi.on("session_switch", async (event) => {
		cmuxClearLog();
		cmuxLog(`Switched session (${event.reason})`);
	});

	// ── compaction ───────────────────────────────────────────────────────

	pi.on("session_compact", async (event) => {
		const source = event.fromExtension ? "custom" : "auto";
		cmuxLog(`Context compacted (${source})`, "warning");
	});

	// ── model changes ────────────────────────────────────────────────────

	pi.on("model_select", async (event) => {
		currentModel = event.model.name;
		cmuxLog(`Model: ${currentModel}`);
		cmuxSetStatus("pi-model", currentModel, "cpu", "#007aff");
	});

	// ── agent loop ───────────────────────────────────────────────────────

	pi.on("agent_start", async () => {
		turnCount = 0;
		toolsThisTurn = 0;
		errorsThisLoop = 0;
		startTime = Date.now();
		activeSubagents = 0;
		completedSubagents = 0;
		loggedSubagents = new Set();
		agentState = "working";
		subagentInfo = null;
		cmuxSetStatus("pi", "working", "terminal.fill", "#ff9500");
		cmuxSetProgress(0, "Starting...");
		flushStats();
	});

	pi.on("agent_end", async (_event) => {
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		const body = buildSummary(elapsed);

		cmuxClearProgress();
		agentState = "idle";
		subagentInfo = null;

		if (errorsThisLoop > 0) {
			cmuxSetStatus("pi", "done (errors)", "exclamationmark.triangle.fill", "#ff3b30");
			cmuxLog(`${body} (${errorsThisLoop} error${errorsThisLoop !== 1 ? "s" : ""})`, "warning");
			notify("Pi", body, "Errors");
		} else {
			cmuxSetStatus("pi", "idle", "checkmark.circle.fill", "#34c759");
			cmuxLog(body, "success");
			notify("Pi", body);
		}

		// Fade status back to neutral after 10s
		setTimeout(() => {
			cmuxSetStatus("pi", "idle", "terminal.fill", "#8e8e93");
		}, 10000);

		flushStats();
	});

	// ── turns ────────────────────────────────────────────────────────────

	pi.on("turn_start", async (event) => {
		turnCount = event.turnIndex + 1;
		toolsThisTurn = 0;
		// Progress: estimate ~10 turns max, cap at 0.9 (never show "done" during work)
		cmuxSetProgress(Math.min(0.9, turnCount / 10), `Turn ${turnCount}`);
	});

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (msg.role === "assistant") {
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
		toolsThisTurn++;
		const name = event.toolName;

		if (name === "subagent") {
			const args = event.args ?? {};
			if (args.chain?.length) {
				const agents = args.chain.map((s: any) => s.agent).join(" → ");
				activeSubagents = args.chain.length;
				completedSubagents = 0;
				subagentInfo = { mode: "chain", agents: args.chain.map((s: any) => s.agent), completed: 0, total: activeSubagents };
				cmuxLog(`Chain: ${agents}`, "progress");
				cmuxSetStatus("pi", `chain (0/${activeSubagents})`, "arrow.triangle.branch", "#af52de");
			} else if (args.tasks?.length) {
				const agents = args.tasks.map((t: any) => t.agent).join(", ");
				activeSubagents = args.tasks.length;
				completedSubagents = 0;
				subagentInfo = { mode: "parallel", agents: args.tasks.map((t: any) => t.agent), completed: 0, total: activeSubagents };
				cmuxLog(`Parallel: ${agents}`, "progress");
				cmuxSetStatus("pi", `fleet (0/${activeSubagents})`, "square.grid.2x2", "#af52de");
			} else if (args.agent) {
				activeSubagents = 1;
				completedSubagents = 0;
				subagentInfo = { mode: "single", agents: [args.agent], completed: 0, total: 1 };
				cmuxLog(`Subagent: ${args.agent}`, "progress");
				cmuxSetStatus("pi", args.agent, "person.fill", "#af52de");
			}
			cmuxSetProgress(0, "Subagents...");
			flushStats();
		} else if (name === "bash") {
			commandsRun++;
			const cmd = String(event.args?.command ?? "").slice(0, 60);
			cmuxLog(`$ ${cmd}${cmd.length >= 60 ? "…" : ""}`, "progress");
			cmuxSetStatus("pi", "bash", "terminal", "#ff9500");
		} else if (name === "edit") {
			const epath = String(event.args?.path ?? "");
			filesEdited.add(basename(epath));
			cmuxLog(`edit: ${basename(epath)}`, "progress");
			cmuxSetStatus("pi", name, "pencil", "#ff9500");
		} else if (name === "write") {
			const wpath = String(event.args?.path ?? "");
			filesCreated.add(basename(wpath));
			cmuxLog(`write: ${basename(wpath)}`, "progress");
			cmuxSetStatus("pi", name, "pencil", "#ff9500");
		} else if (name === "read") {
			const rpath = String(event.args?.path ?? "");
			cmuxLog(`read: ${basename(rpath)}`, "info");
		}
		// grep, find, ls are too noisy to log
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
		const total = activeSubagents;
		const progress = total > 0 ? Math.min(0.9, done / total) : 0;

		if (details.mode === "chain") {
			cmuxSetStatus("pi", `chain (${done}/${total})`, "arrow.triangle.branch", "#af52de");
			cmuxSetProgress(progress, `Chain ${done}/${total}`);
			if (subagentInfo) subagentInfo.completed = done;
		} else if (details.mode === "parallel") {
			cmuxSetStatus("pi", `fleet (${done}/${total})`, "square.grid.2x2", "#af52de");
			cmuxSetProgress(progress, `Fleet ${done}/${total}`);
			if (subagentInfo) subagentInfo.completed = done;
		}

		// Log individual completions
		for (const r of results) {
			if (r.exitCode !== -1 && !loggedSubagents.has(r.agent)) {
				loggedSubagents.add(r.agent);
				const icon = r.exitCode === 0 ? "✓" : "✗";
				const level = r.exitCode === 0 ? "success" : "error";
				cmuxLog(`${icon} ${r.agent} finished`, level);
			}
		}

		flushStats();
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.isError) {
			errorsThisLoop++;
			cmuxLog(`✗ ${event.toolName} failed`, "error");
			cmuxSetStatus("pi", "error", "xmark.circle.fill", "#ff3b30");
			setTimeout(() => {
				cmuxSetStatus("pi", "working", "terminal.fill", "#ff9500");
			}, 3000);
		}

		if (event.toolName === "subagent") {
			const ok = completedSubagents;
			const total = activeSubagents;
			if (total > 1) {
				cmuxLog(`Fleet complete: ${ok}/${total}`, event.isError ? "error" : "success");
			}
			activeSubagents = 0;
			completedSubagents = 0;
			loggedSubagents = new Set();
			subagentInfo = null;
			cmuxClearProgress();
			cmuxSetStatus("pi", "working", "terminal.fill", "#ff9500");
			flushStats();
		}
	});

	// ── user input ───────────────────────────────────────────────────────

	pi.on("input", async () => {
		// User submitted — agent will start working
		cmuxSetStatus("pi", "working", "terminal.fill", "#ff9500");
	});
}
