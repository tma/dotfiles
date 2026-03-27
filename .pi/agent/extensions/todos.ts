/**
 * Todo Tracker Extension (opencode-style)
 *
 * Gives the agent `todo_write` and `todo_read` tools to track multi-step tasks.
 * Shows a persistent progress widget above the editor.
 * State survives branching, forking, and tree navigation via session entries.
 *
 * The agent uses this proactively for complex tasks (3+ steps) to:
 * - Plan work upfront
 * - Show progress to the user
 * - Stay on track after steering/compaction
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, matchesKey } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

// ── Shared state file (read by status-panel.sh) ─────────────────────

const STATS_DIR = path.join(os.tmpdir(), "pi-status");

function getTodosFile(cwd: string): string {
	const safeName = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
	return path.join(STATS_DIR, `${safeName}-${process.pid}-todos.json`);
}

let todosFile = "";

function flushTodos(tasks: Task[]): void {
	if (!todosFile) return;
	try {
		mkdirSync(STATS_DIR, { recursive: true });
		writeFileSync(todosFile, JSON.stringify({ tasks }), "utf-8");
	} catch {}
}

// ── cmux sidebar metadata ───────────────────────────────────────────

function cmux(args: string[]): void {
	try {
		execFile("cmux", args, { timeout: 3000 }, () => {});
	} catch {}
}

function cmuxSetTaskStatus(tasks: Task[]): void {
	if (tasks.length === 0) {
		cmux(["clear-status", "tasks"]);
		return;
	}
	const done = tasks.filter((t) => t.status === "completed" || t.status === "cancelled").length;
	const total = tasks.length;
	const ip = tasks.find((t) => t.status === "in_progress");
	const label = ip ? `${done}/${total} · ${ip.title}` : `${done}/${total}`;
	const color = done === total ? "#34c759" : "#007aff";
	const icon = done === total ? "checkmark.circle.fill" : "checklist";
	cmux(["set-status", "tasks", label, "--icon", icon, "--color", color]);
}

function cmuxLogTask(task: Task): void {
	if (task.status === "completed") {
		cmux(["log", "--level", "success", "--source", "tasks", "--", `✓ ${task.title}`]);
	} else if (task.status === "in_progress") {
		cmux(["log", "--level", "progress", "--source", "tasks", "--", `▸ ${task.title}`]);
	}
}

// ── Types ───────────────────────────────────────────────────────────

type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface Task {
	id: string;
	title: string;
	status: TaskStatus;
}

interface TodoState {
	tasks: Task[];
}

// ── Schema ──────────────────────────────────────────────────────────

const TaskSchema = Type.Object({
	id: Type.String({ description: "Unique task ID (short, e.g. '1', '2a')" }),
	title: Type.String({ description: "Task description" }),
	status: StringEnum(["pending", "in_progress", "completed", "cancelled"] as const, {
		description: "Task state",
	}),
});

const TodoWriteParams = Type.Object({
	tasks: Type.Array(TaskSchema, {
		description:
			"Complete task list. Every call replaces the full list. " +
			"Include all tasks — not just changed ones.",
	}),
});

const TodoReadParams = Type.Object({});

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let state: TodoState = { tasks: [] };

	// ── State reconstruction from session ───────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		state = { tasks: [] };

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo_write") continue;
			const details = msg.details as TodoState | undefined;
			if (details?.tasks) {
				state = { tasks: details.tasks };
			}
		}

		updateWidget(ctx);
	};

	pi.on("session_start", async (_e, ctx) => {
		todosFile = getTodosFile(ctx.cwd);
		reconstructState(ctx);
	});
	pi.on("session_switch", async (_e, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_e, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));

	// Clear widget once the agent finishes and all tasks are done
	pi.on("agent_end", async (_e, ctx) => {
		if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "completed" || t.status === "cancelled")) {
			ctx.ui.setWidget("todos", []);
			flushTodos([]);
			cmuxSetTaskStatus([]);
		}
	});

	// ── Widget ──────────────────────────────────────────────────────

	const updateWidget = (ctx: ExtensionContext) => {
		flushTodos(state.tasks);
		cmuxSetTaskStatus(state.tasks);

		if (state.tasks.length === 0) {
			ctx.ui.setWidget("todos", []);
			return;
		}

		const completed = state.tasks.filter((t) => t.status === "completed").length;
		const cancelled = state.tasks.filter((t) => t.status === "cancelled").length;
		const total = state.tasks.length;
		const active = state.tasks.find((t) => t.status === "in_progress");
		const done = completed + cancelled;

		const bar = progressBar(done, total, 20);
		const lines: string[] = [];
		lines.push(`${bar} ${done}/${total}${active ? ` │ ▸ ${active.title}` : ""}`);

		ctx.ui.setWidget("todos", lines);
	};

	function progressBar(done: number, total: number, width: number): string {
		const filled = Math.round((done / total) * width);
		return "█".repeat(filled) + "░".repeat(width - filled);
	}

	// ── todowrite tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description:
			"Create or update the task list for the current work. " +
			"Each call replaces the full list — include all tasks, not just changes. " +
			"Use status: pending → in_progress → completed/cancelled. " +
			"Only one task should be in_progress at a time.",
		promptSnippet: "Track multi-step task progress with a visible todo list",
		promptGuidelines: [
			"Use todo_write proactively when a task has 3+ steps or involves multiple files.",
			"Create the todo list at the start, update status as you work, mark tasks completed immediately after finishing each one.",
			"Only have one task in_progress at a time. Complete it before starting the next.",
			"Do NOT use todo_write for single trivial tasks or purely conversational requests.",
		],
		parameters: TodoWriteParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Detect changes for logging
			const oldMap = new Map(state.tasks.map((t) => [t.id, t.status]));
			state = { tasks: params.tasks };
			for (const task of params.tasks) {
				const prev = oldMap.get(task.id);
				if (prev !== task.status && (task.status === "completed" || task.status === "in_progress")) {
					cmuxLogTask(task);
				}
			}
			updateWidget(ctx);

			const summary = formatTaskList(state.tasks);
			return {
				content: [{ type: "text", text: summary }],
				details: { tasks: [...state.tasks] } as TodoState,
			};
		},

		renderCall(args, theme) {
			const tasks = (args as Static<typeof TodoWriteParams>).tasks ?? [];
			const done = tasks.filter((t: Task) => t.status === "completed" || t.status === "cancelled").length;
			const ip = tasks.find((t: Task) => t.status === "in_progress");
			let text = theme.fg("toolTitle", theme.bold("todo_write "));
			text += theme.fg("muted", `${done}/${tasks.length} done`);
			if (ip) text += theme.fg("dim", ` │ ▸ ${ip.title}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoState | undefined;
			if (!details?.tasks?.length) {
				return new Text(theme.fg("dim", "No tasks"), 0, 0);
			}
			const tasks = details.tasks;
			const done = tasks.filter((t) => t.status === "completed").length;
			const cancelled = tasks.filter((t) => t.status === "cancelled").length;
			const total = tasks.length;

			let line = theme.fg("success", `${done} done`)
				+ (cancelled ? theme.fg("dim", `, ${cancelled} cancelled`) : "")
				+ theme.fg("muted", ` / ${total} total`);

			if (expanded) {
				for (const t of tasks) {
					const icon = statusIcon(t.status);
					const colored = t.status === "completed" ? theme.fg("success", icon)
						: t.status === "in_progress" ? theme.fg("accent", icon)
						: t.status === "cancelled" ? theme.fg("dim", icon)
						: theme.fg("muted", icon);
					const title = t.status === "completed" || t.status === "cancelled"
						? theme.fg("dim", t.title)
						: theme.fg("text", t.title);
					line += `\n  ${colored} ${title}`;
				}
			}
			return new Text(line, 0, 0);
		},
	});

	// ── todoread tool ───────────────────────────────────────────────

	pi.registerTool({
		name: "todo_read",
		label: "Todo Read",
		description: "Read the current task list to check progress and decide what to work on next.",
		promptSnippet: "Read current todo list state",
		parameters: TodoReadParams,

		async execute() {
			if (state.tasks.length === 0) {
				return {
					content: [{ type: "text", text: "No tasks. Use todo_write to create a task list." }],
					details: { tasks: [] } as TodoState,
				};
			}

			const summary = formatTaskList(state.tasks);
			return {
				content: [{ type: "text", text: summary }],
				details: { tasks: [...state.tasks] } as TodoState,
			};
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoState | undefined;
			if (!details?.tasks?.length) {
				return new Text(theme.fg("dim", "No tasks"), 0, 0);
			}
			const done = details.tasks.filter((t) => t.status === "completed").length;
			let line = theme.fg("muted", `${done}/${details.tasks.length} completed`);
			if (expanded) {
				for (const t of details.tasks) {
					const icon = statusIcon(t.status);
					const colored = t.status === "in_progress" ? theme.fg("accent", icon) : theme.fg("muted", icon);
					line += `\n  ${colored} ${t.title}`;
				}
			}
			return new Text(line, 0, 0);
		},
	});

	// ── /todos command ──────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "Show the current task list",
		handler: async (_args, ctx) => {
			if (state.tasks.length === 0) {
				ctx.ui.notify("No tasks tracked yet", "info");
				return;
			}

			if (!ctx.hasUI) {
				// Print mode fallback
				ctx.ui.notify(formatTaskList(state.tasks), "info");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListOverlay(state.tasks, theme, () => done());
			});
		},
	});
}

// ── Helpers ─────────────────────────────────────────────────────────

function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "pending": return "○";
		case "in_progress": return "▸";
		case "completed": return "✓";
		case "cancelled": return "✗";
	}
}

function formatTaskList(tasks: Task[]): string {
	return tasks.map((t) => `[${statusIcon(t.status)}] ${t.id}. ${t.title}`).join("\n");
}

// ── Overlay component ───────────────────────────────────────────────

class TodoListOverlay {
	private tasks: Task[];
	private theme: any;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tasks: Task[], theme: any, onClose: () => void) {
		this.tasks = tasks;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const lines: string[] = [];

		const completed = this.tasks.filter((t) => t.status === "completed").length;
		const cancelled = this.tasks.filter((t) => t.status === "cancelled").length;
		const total = this.tasks.length;

		lines.push("");
		const title = th.fg("accent", " Tasks ");
		lines.push(truncateToWidth(
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10))),
			width,
		));
		lines.push(truncateToWidth(`  ${th.fg("muted", `${completed}/${total} completed${cancelled ? `, ${cancelled} cancelled` : ""}`)}`, width));
		lines.push("");

		for (const t of this.tasks) {
			const icon = statusIcon(t.status);
			const colored = t.status === "completed" ? th.fg("success", icon)
				: t.status === "in_progress" ? th.fg("accent", icon)
				: t.status === "cancelled" ? th.fg("dim", icon)
				: th.fg("muted", icon);
			const title = t.status === "completed" || t.status === "cancelled"
				? th.fg("dim", t.title)
				: t.status === "in_progress"
				? th.fg("accent", t.title)
				: th.fg("text", t.title);
			lines.push(truncateToWidth(`  ${colored} ${th.fg("muted", t.id + ".")} ${title}`, width));
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape or q to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
