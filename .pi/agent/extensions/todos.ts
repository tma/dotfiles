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

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, matchesKey } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { writeFileSync, accessSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

// ── Shared state file (read by status-panel.sh) ─────────────────────

let todosFile = "";
const panelStateFile = path.join(os.tmpdir(), `pi-${process.pid}-status-panel.json`);

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

function flushTodos(state: TodoState): void {
	if (!todosFile) return;
	try {
		writeFileSync(todosFile, JSON.stringify({
			goal: state.goal ?? null,
			tasks: state.tasks,
		}), "utf-8");
	} catch {}
}

// ── cmux detection ───────────────────────────────────────────────────────

function isCmux(): boolean {
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

function isTmux(): boolean {
	return !!process.env.TMUX && !!process.env.TMUX_PANE;
}

function isTmuxStatusPanelOpen(): boolean {
	if (!isTmux()) return false;
	try {
		accessSync(panelStateFile);
		return true;
	} catch {
		return false;
	}
}

// ── cmux sidebar metadata ───────────────────────────────────────────

function cmux(args: string[]): void {
	try {
		execFile("cmux", args, { timeout: 3000 }, () => {});
	} catch {}
}

function cmuxSetTaskStatus(tasks: Task[]): void {
	// Tasks are shown in the right status panel (status-panel.sh), not the cmux left sidebar
}

function cmuxLogTask(task: Task): void {
	if (task.status === "completed") {
		cmux(["log", "--level", "success", "--source", "tasks", "--", `✓ ${task.title}`]);
	} else if (task.status === "in_progress") {
		cmux(["log", "--level", "progress", "--source", "tasks", "--", `▸ ${task.title}`]);
	} else if (task.status === "cancelled") {
		cmux(["log", "--level", "warning", "--source", "tasks", "--", `✗ ${task.title}`]);
	}
}

function cmuxNotifyAllDone(tasks: Task[]): void {
	const completed = tasks.filter((t) => t.status === "completed").length;
	const cancelled = tasks.filter((t) => t.status === "cancelled").length;
	const total = tasks.length;
	let body = `All ${total} tasks completed!`;
	if (cancelled > 0) body = `${completed} completed, ${cancelled} cancelled`;
	cmux(["notify", "--title", "✅ Tasks Done", "--body", body]);
}

// ── Types ───────────────────────────────────────────────────────────

type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
type GoalStatus = "active" | "paused" | "blocked" | "complete";

interface Task {
	id: string;
	title: string;
	status: TaskStatus;
}

interface Goal {
	objective: string;
	status: GoalStatus;
	createdAt: number;
	updatedAt: number;
	note?: string;
}

interface TodoState {
	goal?: Goal | null;
	tasks: Task[];
	clearedTasks?: Task[];
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

const GoalSetParams = Type.Object({
	objective: Type.String({ description: "Durable objective / north star for the current work" }),
	status: Type.Optional(StringEnum(["active", "paused", "blocked", "complete"] as const, {
		description: "Goal status. Defaults to active.",
	})),
	note: Type.Optional(Type.String({ description: "Optional short note about constraints, acceptance criteria, or blocker" })),
});

const GoalUpdateParams = Type.Object({
	status: Type.Optional(StringEnum(["active", "paused", "blocked", "complete"] as const, {
		description: "New goal status",
	})),
	objective: Type.Optional(Type.String({ description: "Updated durable objective" })),
	note: Type.Optional(Type.String({ description: "Optional short note about constraints, acceptance criteria, or blocker" })),
});

const GoalReadParams = Type.Object({});

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let state: TodoState = { tasks: [] };
	let currentCtx: ExtensionContext | null = null;
	let lastWidgetSuppressed: boolean | null = null;
	let panelPoll: ReturnType<typeof setInterval> | null = null;

	// ── State reconstruction from session ───────────────────────────

	const shouldSuppressWidget = (): boolean => isCmux() || isTmuxStatusPanelOpen();

	const ensurePanelPolling = () => {
		if (panelPoll) return;
		panelPoll = setInterval(() => {
			if (!currentCtx) return;
			const suppressed = shouldSuppressWidget();
			if (suppressed !== lastWidgetSuppressed) {
				updateWidget(currentCtx);
			}
		}, 500);
		panelPoll.unref?.();
	};

	const applyStateSnapshot = (snapshot: TodoState | undefined) => {
		if (!snapshot) return;
		if (Array.isArray(snapshot.tasks)) state.tasks = snapshot.tasks;
		if ("goal" in snapshot) state.goal = snapshot.goal ?? undefined;
	};

	const reconstructState = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		ensurePanelPolling();
		state = { tasks: [] };

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "todos-state") {
				applyStateSnapshot(entry.data as TodoState | undefined);
				continue;
			}

			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult") continue;
			if (!["todo_write", "goal_set", "goal_update", "goal_read"].includes(msg.toolName)) continue;
			applyStateSnapshot(msg.details as TodoState | undefined);
		}

		updateWidget(ctx);
	};

	const loadSessionState = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		const sessionDir = getStateDir(ctx.sessionManager.getSessionFile());
		todosFile = path.join(sessionDir, `${process.pid}-todos.json`);
		reconstructState(ctx);
	};

	pi.on("session_start", async (_e, ctx) => {
		loadSessionState(ctx);
	});
	pi.on("session_switch", async (_e, ctx) => {
		loadSessionState(ctx);
	});
	pi.on("session_fork", async (_e, ctx) => {
		loadSessionState(ctx);
	});
	pi.on("session_tree", async (_e, ctx) => {
		currentCtx = ctx;
		reconstructState(ctx);
	});

	// Clear widget once the agent finishes and all tasks are done
	pi.on("agent_end", async (_e, ctx) => {
		if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "completed" || t.status === "cancelled")) {
			state = { ...state, tasks: [] };
			updateWidget(ctx);
		}
	});

	// ── Widget ──────────────────────────────────────────────────────

	const updateWidget = (ctx: ExtensionContext) => {
		flushTodos(state);
		cmuxSetTaskStatus(state.tasks);

		const suppressWidget = shouldSuppressWidget();
		lastWidgetSuppressed = suppressWidget;

		// In cmux, and in tmux while the right status panel is open, work state lives
		// in the side panel instead of the horizontal editor widget.
		if (suppressWidget) {
			ctx.ui.setWidget("todos", []);
			return;
		}

		if (!state.goal && state.tasks.length === 0) {
			ctx.ui.setWidget("todos", []);
			return;
		}

		const lines: string[] = [];
		if (state.goal) {
			lines.push(formatGoalLine(state.goal));
		}

		if (state.tasks.length > 0) {
			const completed = state.tasks.filter((t) => t.status === "completed").length;
			const cancelled = state.tasks.filter((t) => t.status === "cancelled").length;
			const total = state.tasks.length;
			const active = state.tasks.find((t) => t.status === "in_progress");
			const done = completed + cancelled;

			const bar = progressBar(done, total, 20);
			lines.push(`${bar} ${done}/${total}${active ? ` │ ▸ ${active.title}` : ""}`);
		}

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
			"When all work is finished, call todo_write once with the full list marked completed/cancelled; the list is cleared automatically.",
			"Do NOT use todo_write for single trivial tasks or purely conversational requests.",
		],
		parameters: TodoWriteParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const previousTasks = [...state.tasks];
			const submittedTasks = [...params.tasks];
			const allSubmittedTasksDone = submittedTasks.length > 0
				&& submittedTasks.every((t) => t.status === "completed" || t.status === "cancelled");

			// Detect changes for logging
			const oldMap = new Map(previousTasks.map((t) => [t.id, t.status]));
			for (const task of submittedTasks) {
				const prev = oldMap.get(task.id);
				if (prev !== task.status && (task.status === "completed" || task.status === "in_progress" || task.status === "cancelled")) {
					cmuxLogTask(task);
				}
			}

			if (allSubmittedTasksDone) {
				cmuxNotifyAllDone(submittedTasks);
				state = { ...state, tasks: [] };
			} else {
				state = { ...state, tasks: submittedTasks };
			}
			updateWidget(ctx);

			const clearedTasks = allSubmittedTasksDone ? submittedTasks
				: state.tasks.length === 0 ? previousTasks
				: undefined;
			const summary = clearedTasks
				? formatClearedTaskSummary(clearedTasks)
				: formatTaskList(state.tasks);
			return {
				content: [{ type: "text", text: summary }],
				details: { goal: state.goal ?? null, tasks: [...state.tasks], clearedTasks } as TodoState,
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

		renderResult(result, _options, theme) {
			const details = result.details as TodoState | undefined;
			if (!details?.tasks?.length) {
				if (details?.clearedTasks?.length) {
					const cleared = details.clearedTasks;
					const done = cleared.filter((t) => t.status === "completed").length;
					const cancelled = cleared.filter((t) => t.status === "cancelled").length;
					const line = theme.fg("success", "Todo list cleared")
						+ theme.fg("muted", ` · ${done} completed`)
						+ (cancelled ? theme.fg("dim", `, ${cancelled} cancelled`) : "")
						+ formatTaskListForRender(cleared, theme);
					return new Text(line, 0, 0);
				}
				return new Text(theme.fg("dim", "No tasks"), 0, 0);
			}
			const tasks = details.tasks;
			const done = tasks.filter((t) => t.status === "completed").length;
			const cancelled = tasks.filter((t) => t.status === "cancelled").length;
			const total = tasks.length;

			const line = theme.fg("success", `${done} done`)
				+ (cancelled ? theme.fg("dim", `, ${cancelled} cancelled`) : "")
				+ theme.fg("muted", ` / ${total} total`)
				+ formatTaskListForRender(tasks, theme);
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
				details: { goal: state.goal ?? null, tasks: [...state.tasks] } as TodoState,
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as TodoState | undefined;
			if (!details?.tasks?.length) {
				return new Text(theme.fg("dim", "No tasks"), 0, 0);
			}
			const done = details.tasks.filter((t) => t.status === "completed").length;
			const line = theme.fg("muted", `${done}/${details.tasks.length} completed`)
				+ formatTaskListForRender(details.tasks, theme);
			return new Text(line, 0, 0);
		},
	});

	// ── Goal tools ──────────────────────────────────────────────────

	const persistState = () => {
		pi.appendEntry("todos-state", { goal: state.goal ?? null, tasks: [...state.tasks] });
	};

	const setGoal = (objective: string, status: GoalStatus = "active", note?: string): Goal => {
		const now = Date.now();
		const existing = state.goal;
		const goal: Goal = {
			objective: objective.trim(),
			status,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			...(note?.trim() ? { note: note.trim() } : existing?.note ? { note: existing.note } : {}),
		};
		state = { ...state, goal };
		return goal;
	};

	pi.registerTool({
		name: "goal_set",
		label: "Goal Set",
		description: "Set the durable objective / north star for the current work. Use for long-running, autonomous, or multi-turn work; use todos for the current execution plan.",
		promptSnippet: "Set durable work goal / north star",
		promptGuidelines: [
			"Use goal_set when work has a durable objective that may span multiple turns, todo batches, compaction, or handoff.",
			"Do not use goal_set for trivial, one-shot, or purely conversational tasks.",
			"Use todos for the current execution plan; use the goal for the stable outcome/why.",
			"If a goal already exists, read it and continue under it; do not replace it unless the prior goal is complete or clearly obsolete.",
		],
		parameters: GoalSetParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const objective = params.objective.trim();
			if (!objective) {
				return { content: [{ type: "text", text: "Goal objective cannot be empty." }], details: { goal: state.goal ?? null, tasks: [...state.tasks] } as TodoState };
			}
			const goal = setGoal(objective, params.status ?? "active", params.note);
			updateWidget(ctx);
			return {
				content: [{ type: "text", text: formatGoalSummary(goal) }],
				details: { goal, tasks: [...state.tasks] } as TodoState,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("goal_set "));
			text += theme.fg("accent", args.objective ?? "");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TodoState | undefined;
			if (!details?.goal) return new Text(theme.fg("dim", "No goal"), 0, 0);
			return new Text(renderGoal(details.goal, theme), 0, 0);
		},
	});

	pi.registerTool({
		name: "goal_update",
		label: "Goal Update",
		description: "Update the current goal objective, note, or status. Mark complete only when the durable objective is actually achieved.",
		promptSnippet: "Update current goal objective or status",
		promptGuidelines: [
			"Use goal_update to mark a goal complete only when the user's durable objective is actually achieved.",
			"Use goal_update with status blocked when the goal cannot proceed without a user decision, missing dependency, or external unblock.",
		],
		parameters: GoalUpdateParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state.goal) {
				return { content: [{ type: "text", text: "No goal is currently set." }], details: { goal: null, tasks: [...state.tasks] } as TodoState };
			}
			const objective = params.objective?.trim() || state.goal.objective;
			const goal: Goal = {
				...state.goal,
				objective,
				status: params.status ?? state.goal.status,
				updatedAt: Date.now(),
				...(params.note !== undefined ? (params.note.trim() ? { note: params.note.trim() } : { note: undefined }) : {}),
			};
			state = { ...state, goal };
			updateWidget(ctx);
			return {
				content: [{ type: "text", text: formatGoalSummary(goal) }],
				details: { goal, tasks: [...state.tasks] } as TodoState,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("goal_update "));
			text += theme.fg("muted", args.status ?? "goal");
			if (args.objective) text += theme.fg("dim", ` │ ${args.objective}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TodoState | undefined;
			if (!details?.goal) return new Text(theme.fg("dim", "No goal"), 0, 0);
			return new Text(renderGoal(details.goal, theme), 0, 0);
		},
	});

	pi.registerTool({
		name: "goal_read",
		label: "Goal Read",
		description: "Read the current durable goal and task list context.",
		promptSnippet: "Read current durable goal",
		parameters: GoalReadParams,

		async execute() {
			if (!state.goal) {
				return {
					content: [{ type: "text", text: "No goal is currently set." }],
					details: { goal: null, tasks: [...state.tasks] } as TodoState,
				};
			}
			return {
				content: [{ type: "text", text: formatGoalSummary(state.goal) }],
				details: { goal: state.goal, tasks: [...state.tasks] } as TodoState,
			};
		},

		renderResult(result, _options, theme) {
			const details = result.details as TodoState | undefined;
			if (!details?.goal) return new Text(theme.fg("dim", "No goal"), 0, 0);
			return new Text(renderGoal(details.goal, theme), 0, 0);
		},
	});

	// ── /goal command ────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set, view, update, or clear the current work goal",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			const command = input.toLowerCase();

			if (!input) {
				ctx.ui.notify(state.goal ? formatGoalSummary(state.goal) : "No goal set. Usage: /goal <objective>", "info");
				return;
			}

			if (command === "clear") {
				state = { ...state, goal: undefined };
				persistState();
				updateWidget(ctx);
				ctx.ui.notify("Goal cleared", "info");
				return;
			}

			if (command === "edit") {
				if (!state.goal) {
					ctx.ui.notify("No goal set. Usage: /goal <objective>", "info");
					return;
				}
				const edited = await ctx.ui.editor("Edit goal", state.goal.objective);
				if (edited === undefined) return;
				const objective = edited.trim();
				if (!objective) {
					ctx.ui.notify("Goal objective cannot be empty", "warning");
					return;
				}
				setGoal(objective, state.goal.status, state.goal.note);
				persistState();
				updateWidget(ctx);
				ctx.ui.notify(formatGoalSummary(state.goal!), "info");
				return;
			}

			const statusAliases: Record<string, GoalStatus> = {
				active: "active",
				resume: "active",
				paused: "paused",
				pause: "paused",
				blocked: "blocked",
				block: "blocked",
				complete: "complete",
				done: "complete",
			};

			const nextStatus = statusAliases[command];
			if (nextStatus) {
				if (!state.goal) {
					ctx.ui.notify("No goal set. Usage: /goal <objective>", "info");
					return;
				}
				state = { ...state, goal: { ...state.goal, status: nextStatus, updatedAt: Date.now() } };
				persistState();
				updateWidget(ctx);
				ctx.ui.notify(formatGoalSummary(state.goal!), "info");
				return;
			}

			setGoal(input);
			persistState();
			updateWidget(ctx);
			ctx.ui.notify(formatGoalSummary(state.goal!), "info");
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

function goalStatusIcon(status: GoalStatus): string {
	switch (status) {
		case "active": return "●";
		case "paused": return "◌";
		case "blocked": return "▲";
		case "complete": return "✓";
	}
}

function formatGoalLine(goal: Goal): string {
	const note = goal.note ? ` │ ${goal.note}` : "";
	return `${goalStatusIcon(goal.status)} ${goal.objective}${note}`;
}

function formatGoalSummary(goal: Goal): string {
	const note = goal.note ? `\nNote: ${goal.note}` : "";
	return `Goal ${goal.status}: ${goal.objective}${note}`;
}

function renderGoal(goal: Goal, theme: { fg: (color: string, text: string) => string }): string {
	const color = goal.status === "complete" ? "success"
		: goal.status === "blocked" ? "warning"
		: goal.status === "paused" ? "dim"
		: "accent";
	let text = theme.fg(color, `${goalStatusIcon(goal.status)} `);
	text += theme.fg("text", goal.objective);
	if (goal.note) text += theme.fg("dim", ` · ${goal.note}`);
	return text;
}

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

function formatTaskListForRender(tasks: Task[], theme: {
	fg: (color: string, text: string) => string;
}): string {
	let text = "";
	for (const task of tasks) {
		const icon = statusIcon(task.status);
		const colored = task.status === "completed" ? theme.fg("success", icon)
			: task.status === "in_progress" ? theme.fg("accent", icon)
			: task.status === "cancelled" ? theme.fg("dim", icon)
			: theme.fg("muted", icon);
		const id = theme.fg("muted", `${task.id}.`);
		const title = task.status === "completed" || task.status === "cancelled"
			? theme.fg("dim", task.title)
			: task.status === "in_progress"
			? theme.fg("accent", task.title)
			: theme.fg("text", task.title);
		text += `\n  ${colored} ${id} ${title}`;
	}
	return text;
}

function formatClearedTaskSummary(tasks: Task[]): string {
	if (tasks.length === 0) {
		return "Todo list cleared.";
	}

	const completed = tasks.filter((t) => t.status === "completed").length;
	const cancelled = tasks.filter((t) => t.status === "cancelled").length;
	let summary = `Todo list cleared. ${completed} completed`;
	if (cancelled > 0) summary += `, ${cancelled} cancelled`;
	summary += ".";
	return `${summary}\n${formatTaskList(tasks)}`;
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
