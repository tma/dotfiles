/**
 * Subagent extension — lightweight multi-agent orchestration for pi.
 *
 * Based on pi's built-in subagent example, enhanced with:
 *   - /dispatch command — decomposes a task into parallel subtasks or executes a plan
 *   - /run <agent> <task> — single agent dispatch
 *   - /chain agent1 -> agent2 -- <task> — sequential pipeline
 *   - Duration + cost tracking
 *   - Tab-completion for agent names
 *   - Output truncation to avoid context blowup
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type AutocompleteItem,
	getAgentDir,
	getMarkdownTheme,
	parseFrontmatter,
	withFileMutationQueue,
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { findPlanFile } from "./plan.js";

// ─── Agent discovery ────────────────────────────────────────────────────────

type AgentScope = "user" | "project" | "both";

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	maxOutputLines?: number;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			maxOutputLines: frontmatter.maxOutputLines ? Number(frontmatter.maxOutputLines) : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Project agents override user agents with the same name
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	if (scope !== "user") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60000);
	const secs = Math.round((ms % 60000) / 1000);
	return `${mins}m${secs}s`;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function addUsage(a: UsageStats, b: UsageStats): UsageStats {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		contextTokens: Math.max(a.contextTokens, b.contextTokens),
		turns: a.turns + b.turns,
	};
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	durationMs?: number;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
}

// ─── Output extraction ─────────────────────────────────────────────────────

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getToolCallSummary(messages: Message[]): string[] {
	const calls: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const args = part.arguments as Record<string, unknown>;
			switch (part.name) {
				case "bash": {
					const cmd = (args.command as string) || "...";
					calls.push(`$ ${cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd}`);
					break;
				}
				case "read":
					calls.push(`read ${shortenPath((args.path as string) || "...")}`);
					break;
				case "write":
					calls.push(`write ${shortenPath((args.path as string) || "...")}`);
					break;
				case "edit":
					calls.push(`edit ${shortenPath((args.path as string) || "...")}`);
					break;
				default:
					calls.push(`${part.name}`);
			}
		}
	}
	return calls;
}

// ─── Concurrency ────────────────────────────────────────────────────────────

async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

// ─── Pi process spawning ────────────────────────────────────────────────────

function getPiCommand(args: string[]): { command: string; args: string[] } {
	const entry = process.argv[1];
	if (entry && fs.existsSync(entry)) {
		return { command: process.execPath, args: [entry, ...args] };
	}
	return { command: "pi", args };
}

async function writePromptFile(name: string, prompt: string): Promise<{ dir: string; path: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));
	const filePath = path.join(dir, `prompt-${name.replace(/[^\w.-]+/g, "_")}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir, path: filePath };
}

type OnUpdate = (partial: AgentToolResult<SubagentDetails>) => void;

async function runAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	opts: {
		cwd?: string;
		step?: number;
		signal?: AbortSignal;
		onUpdate?: OnUpdate;
		makeDetails: (results: SingleResult[]) => SubagentDetails;
	},
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent "${agentName}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`,
			usage: emptyUsage(),
			step: opts.step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	let tmpFile: string | null = null;

	const result: SingleResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step: opts.step,
	};

	const startTime = Date.now();

	const emitUpdate = () => {
		opts.onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(result.messages) || "(running…)" }],
			details: opts.makeDetails([result]),
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptFile(agent.name, agent.systemPrompt);
			tmpDir = tmp.dir;
			tmpFile = tmp.path;
			args.push("--append-system-prompt", tmpFile);
		}

		args.push(`Task: ${task}`);
		let aborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const inv = getPiCommand(args);
			// Strip mux-specific env vars and add an explicit guard so subagents
			// never auto-open cmux/tmux status panels or sidebar integrations.
			const childEnv = {
				...Object.fromEntries(
					Object.entries(process.env).filter(
						([key]) => !key.startsWith("CMUX_") && key !== "TMUX" && key !== "TMUX_PANE",
					)
				),
				CMUX_SOCKET_PATH: "/dev/null/disabled",
				PI_DISABLE_MUX_UI: "1",
			};
			const proc = spawn(inv.command, inv.args, {
				cwd: opts.cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});

			let buf = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}

				if (ev.type === "message_end" && ev.message) {
					const msg = ev.message as Message;
					result.messages.push(msg);
					if (msg.role === "assistant") {
						result.usage.turns++;
						const u = msg.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							result.usage.contextTokens = u.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (ev.type === "tool_result_end" && ev.message) {
					result.messages.push(ev.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buf += data.toString();
				const lines = buf.split("\n");
				buf = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buf.trim()) processLine(buf);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (opts.signal) {
				const kill = () => {
					aborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (opts.signal.aborted) kill();
				else opts.signal.addEventListener("abort", kill, { once: true });
			}
		});

		result.exitCode = exitCode;
		result.durationMs = Date.now() - startTime;
		if (aborted) throw new Error("Subagent aborted");

		// Apply per-agent output line limits (maxOutputLines frontmatter)
		if (agent.maxOutputLines) {
			for (let i = result.messages.length - 1; i >= 0; i--) {
				const msg = result.messages[i];
				if (msg.role === "assistant") {
					for (const part of msg.content) {
						if (part.type === "text") {
							const lines = part.text.split("\n");
							if (lines.length > agent.maxOutputLines) {
								part.text = lines.slice(0, agent.maxOutputLines).join("\n")
									+ `\n\n[Truncated: ${lines.length} → ${agent.maxOutputLines} lines]`;
							}
						}
					}
					break;
				}
			}
		}

		return result;
	} finally {
		if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {}
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch {}
	}
}

// ─── Truncation ─────────────────────────────────────────────────────────────

function truncateOutput(text: string): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (t.truncated) {
		return t.content + `\n\n[Truncated: showing ${t.outputLines}/${t.totalLines} lines]`;
	}
	return t.content;
}

// ─── Tool rendering helpers ─────────────────────────────────────────────────

function renderResultIcon(r: SingleResult, theme: any): string {
	if (r.exitCode === -1) return theme.fg("warning", "●"); // running
	if (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted") return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function isRunning(r: SingleResult): boolean {
	return r.exitCode === -1;
}

function renderCollapsedResult(r: SingleResult, theme: any): string {
	const icon = renderResultIcon(r, theme);
	const toolCalls = getToolCallSummary(r.messages);
	const output = getFinalOutput(r.messages);
	const duration = r.durationMs ? theme.fg("dim", ` ${formatDuration(r.durationMs)}`) : "";

	let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${duration}`;

	if (isRunning(r)) {
		// Show what the agent is currently doing
		const lastCall = toolCalls[toolCalls.length - 1];
		if (lastCall) {
			text += `\n${theme.fg("muted", "→ ")}${theme.fg("dim", lastCall)}`;
		} else {
			text += ` ${theme.fg("muted", "(starting…)")}`;
		}
		if (toolCalls.length > 1) {
			text += theme.fg("dim", ` (${toolCalls.length} tools)`);
		}
	} else if (r.exitCode !== 0 && r.errorMessage) {
		text += `\n${theme.fg("error", r.errorMessage)}`;
	} else if (toolCalls.length === 0 && !output) {
		text += ` ${theme.fg("muted", "(no output)")}`;
	} else {
		// Show last few tool calls
		const shown = toolCalls.slice(-5);
		if (toolCalls.length > 5) text += `\n${theme.fg("muted", `… ${toolCalls.length - 5} earlier`)}`;
		for (const call of shown) {
			text += `\n${theme.fg("muted", "→ ")}${theme.fg("dim", call)}`;
		}
	}

	const usage = formatUsage(r.usage, r.model);
	if (usage) text += `\n${theme.fg("dim", usage)}`;
	return text;
}

function renderExpandedResult(r: SingleResult, theme: any): Container {
	const c = new Container();
	const icon = renderResultIcon(r, theme);
	const duration = r.durationMs ? ` ${formatDuration(r.durationMs)}` : "";
	c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("dim", duration)}`, 0, 0));

	if (r.exitCode !== 0 && r.errorMessage) {
		c.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	c.addChild(new Spacer(1));
	c.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	c.addChild(new Text(theme.fg("dim", r.task), 0, 0));

	const toolCalls = getToolCallSummary(r.messages);
	if (toolCalls.length > 0) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("muted", "─── Tools ───"), 0, 0));
		for (const call of toolCalls) {
			c.addChild(new Text(`${theme.fg("muted", "→ ")}${theme.fg("dim", call)}`, 0, 0));
		}
	}

	const output = getFinalOutput(r.messages);
	if (output) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		c.addChild(new Markdown(truncateOutput(output).trim(), 0, 0, getMarkdownTheme()));
	}

	const usage = formatUsage(r.usage, r.model);
	if (usage) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}

	return c;
}

// ─── Slash command argument parsing ─────────────────────────────────────────

function parseQuotedArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inQuote) {
			if (ch === inQuote) {
				inQuote = null;
			} else {
				current += ch;
			}
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
		} else if (ch === " " && current) {
			args.push(current);
			current = "";
		} else if (ch !== " ") {
			current += ch;
		}
	}
	if (current) args.push(current);
	return args;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Agent name completions for slash commands
	function agentCompletions(prefix: string): AutocompleteItem[] | null {
		const { agents } = discoverAgents(process.cwd(), "both");
		const items = agents
			.filter((a) => a.name.startsWith(prefix))
			.map((a) => ({ value: a.name, label: `${a.name} — ${a.description}` }));
		return items.length > 0 ? items : null;
	}

	// ─── Tool schemas ─────────────────────────────────────────────────────

	const TaskItem = Type.Object({
		agent: Type.String({ description: "Agent name" }),
		task: Type.String({ description: "Task to delegate" }),
		cwd: Type.Optional(Type.String({ description: "Working directory" })),
	});

	const ChainItem = Type.Object({
		agent: Type.String({ description: "Agent name" }),
		task: Type.String({ description: "Task with optional {previous} placeholder" }),
		cwd: Type.Optional(Type.String({ description: "Working directory" })),
	});

	const SubagentParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task (single mode)" })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run in parallel" })),
		chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain steps" })),
		cwd: Type.Optional(Type.String({ description: "Working directory" })),
	});

	// ─── Subagent tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Agents",
		description: [
			"Delegate tasks to specialized agents with isolated context windows.",
			"Modes: single (agent + task), parallel (tasks[]), chain (steps with {previous}).",
			"Available agents are defined in ~/.pi/agent/agents/ and .pi/agents/ as markdown files.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_id, params, signal, onUpdate, ctx) {
			const { agents } = discoverAgents(ctx.cwd, "both");
			const makeDetails = (mode: SubagentDetails["mode"]) => (results: SingleResult[]): SubagentDetails => ({ mode, results });

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);

			if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
				const list = agents.map((a) => `${a.name}: ${a.description}`).join("\n");
				return {
					content: [{ type: "text", text: `Provide exactly one mode (single/parallel/chain).\n\nAvailable agents:\n${list || "none"}` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			// ── Chain ──
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];

					// Compress previous output to avoid context bloat in downstream steps
					const MAX_PREVIOUS_CHARS = 4000;
					let previousForTask = previousOutput;
					if (previousOutput.length > MAX_PREVIOUS_CHARS) {
						previousForTask = previousOutput.slice(0, MAX_PREVIOUS_CHARS)
							+ `\n\n[Output truncated: ${previousOutput.length} chars total, showing first ${MAX_PREVIOUS_CHARS}]`;
					}
					const task = step.task.replace(/\{previous\}/g, previousForTask);

					const chainOnUpdate: OnUpdate | undefined = onUpdate
						? (partial) => {
								const cur = partial.details?.results[0];
								if (cur) onUpdate({ content: partial.content, details: makeDetails("chain")([...results, cur]) });
							}
						: undefined;

					const r = await runAgent(ctx.cwd, agents, step.agent, task, {
						cwd: step.cwd,
						step: i + 1,
						signal,
						onUpdate: chainOnUpdate,
						makeDetails: makeDetails("chain"),
					});
					results.push(r);

					if (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted") {
						const err = r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${err}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(r.messages);
				}

				return {
					content: [{ type: "text", text: truncateOutput(getFinalOutput(results[results.length - 1].messages) || "(no output)") }],
					details: makeDetails("chain")(results),
				};
			}

			// ── Parallel ──
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL) {
					return {
						content: [{ type: "text", text: `Max ${MAX_PARALLEL} tasks` }],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				const live: (SingleResult | undefined)[] = new Array(params.tasks.length).fill(undefined);

				const emitParallel = () => {
					if (!onUpdate) return;
					const filled = live.filter((r): r is SingleResult => r !== undefined);
					const done = filled.filter((r) => r.exitCode !== -1).length;
					onUpdate({
						content: [{ type: "text", text: `${done}/${params.tasks!.length} done` }],
						details: makeDetails("parallel")(filled),
					});
				};

				// Initialize placeholders
				for (let i = 0; i < params.tasks.length; i++) {
					live[i] = {
						agent: params.tasks[i].agent,
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: emptyUsage(),
					};
				}

				const results = await mapConcurrent(params.tasks, MAX_CONCURRENCY, async (t, i) => {
					const r = await runAgent(ctx.cwd, agents, t.agent, t.task, {
						cwd: t.cwd,
						signal,
						onUpdate: (partial) => {
							const cur = partial.details?.results[0];
							if (cur) { live[i] = { ...cur, exitCode: -1 }; emitParallel(); }
						},
						makeDetails: makeDetails("parallel"),
					});
					live[i] = r;
					emitParallel();
					return r;
				});

				const ok = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const out = getFinalOutput(r.messages);
					const preview = out.length > 200 ? out.slice(0, 200) + "…" : out;
					return `[${r.agent}] ${r.exitCode === 0 ? "✓" : "✗"}: ${preview || "(no output)"}`;
				});

				return {
					content: [{ type: "text", text: truncateOutput(`${ok}/${results.length} succeeded\n\n${summaries.join("\n\n")}`) }],
					details: makeDetails("parallel")(results),
				};
			}

			// ── Single ──
			if (params.agent && params.task) {
				const r = await runAgent(ctx.cwd, agents, params.agent, params.task, {
					cwd: params.cwd,
					signal,
					onUpdate,
					makeDetails: makeDetails("single"),
				});

				const isErr = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				if (isErr) {
					return {
						content: [{ type: "text", text: r.errorMessage || r.stderr || getFinalOutput(r.messages) || "Failed" }],
						details: makeDetails("single")([r]),
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: truncateOutput(getFinalOutput(r.messages) || "(no output)") }],
					details: makeDetails("single")([r]),
				};
			}

			return {
				content: [{ type: "text", text: "Invalid params" }],
				details: makeDetails("single")([]),
				isError: true,
			};
		},

		// ── Render: tool call header ──
		renderCall(args, theme) {
			if (args.chain?.length) {
				const agents = args.chain.map((s: any) => s.agent);
				const flow = agents.map((a: string) => theme.fg("accent", a)).join(theme.fg("muted", " → "));
				return new Text(`${theme.fg("toolTitle", theme.bold("agents "))}${flow}`, 0, 0);
			}
			if (args.tasks?.length) {
				const agents = args.tasks.map((t: any) => t.agent);
				const list = agents.map((a: string) => theme.fg("accent", a)).join(theme.fg("muted", " | "));
				return new Text(`${theme.fg("toolTitle", theme.bold("agents "))}${list}`, 0, 0);
			}
			return new Text(
				`${theme.fg("toolTitle", theme.bold("agent "))}${theme.fg("accent", args.agent || "?")}`,
				0,
				0,
			);
		},

		// ── Render: tool result ──
		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			// Single
			if (details.mode === "single" && details.results.length === 1) {
				return expanded
					? renderExpandedResult(details.results[0], theme)
					: new Text(renderCollapsedResult(details.results[0], theme), 0, 0);
			}

			// Chain / Parallel
			const total = details.results.reduce((acc, r) => addUsage(acc, r.usage), emptyUsage());
			const totalDuration = details.results.reduce((sum, r) => sum + (r.durationMs || 0), 0);
			const ok = details.results.filter((r) => r.exitCode === 0).length;
			const icon = ok === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const modeLabel = details.mode === "chain" ? "chain" : "agents";

			if (expanded) {
				const c = new Container();
				c.addChild(new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))} ${theme.fg("accent", `${ok}/${details.results.length}`)} ${theme.fg("dim", formatDuration(totalDuration))}`,
					0, 0,
				));

				for (const r of details.results) {
					c.addChild(new Spacer(1));
					const stepLabel = r.step ? `Step ${r.step}: ` : "";
					c.addChild(new Text(theme.fg("muted", `─── ${stepLabel}`) + theme.fg("accent", r.agent) + ` ${renderResultIcon(r, theme)}`, 0, 0));
					c.addChild(renderExpandedResult(r, theme));
				}

				const usage = formatUsage(total);
				if (usage) {
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
				}

				return c;
			}

			// Collapsed multi-result
			const running = details.results.filter((r) => isRunning(r)).length;
			const done = details.results.filter((r) => !isRunning(r)).length;
			const headerIcon = running > 0
				? theme.fg("warning", "●")
				: ok === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const status = running > 0
				? `${done}/${details.results.length} done, ${running} running`
				: `${ok}/${details.results.length}`;

			let text = `${headerIcon} ${theme.fg("toolTitle", theme.bold(modeLabel))} ${theme.fg("accent", status)} ${theme.fg("dim", formatDuration(totalDuration))}`;
			for (const r of details.results) {
				const ri = renderResultIcon(r, theme);
				const stepLabel = r.step ? `Step ${r.step}: ` : "";
				const duration = r.durationMs ? theme.fg("dim", ` ${formatDuration(r.durationMs)}`) : "";

				if (isRunning(r)) {
					const lastCall = getToolCallSummary(r.messages).slice(-1)[0];
					const tools = getToolCallSummary(r.messages).length;
					const activity = lastCall
						? `${theme.fg("dim", lastCall)}${tools > 1 ? theme.fg("muted", ` (${tools} tools)`) : ""}`
						: theme.fg("muted", "(starting…)");
					text += `\n${ri} ${theme.fg("muted", stepLabel)}${theme.fg("accent", r.agent)} ${activity}`;
				} else {
					const output = getFinalOutput(r.messages);
					const preview = output ? (output.length > 80 ? output.slice(0, 80) + "…" : output) : "(no output)";
					text += `\n${ri} ${theme.fg("muted", stepLabel)}${theme.fg("accent", r.agent)}${duration} ${theme.fg("dim", preview)}`;
				}
			}
			const usage = formatUsage(total);
			if (usage) text += `\n${theme.fg("dim", `Total: ${usage}`)}`;
			return new Text(text, 0, 0);
		},
	});

	// ─── /run <agent> <task> ──────────────────────────────────────────────

	pi.registerCommand("run", {
		description: "Run a single agent: /run <agent> <task>",
		getArgumentCompletions: agentCompletions,
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				const { agents } = discoverAgents(ctx.cwd, "both");
				const list = agents.map((a) => `  ${a.name} — ${a.description}`).join("\n");
				ctx.ui.notify(`Usage: /run <agent> <task>\n\nAgents:\n${list || "  (none)"}`, "info");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const agentName = parts[0];
			const task = parts.slice(1).join(" ");

			if (!task) {
				ctx.ui.notify(`Usage: /run ${agentName} <task>`, "warning");
				return;
			}

			pi.sendUserMessage(
				`Use the subagent tool to run agent "${agentName}" with this task: ${task}`,
				{ deliverAs: "followUp" },
			);
		},
	});

	// ─── /chain agent1 -> agent2 -- <task> ───────────────────────────────

	pi.registerCommand("chain", {
		description: "Run agents in sequence: /chain scout -> coder -- <task>",
		getArgumentCompletions: agentCompletions,
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /chain agent1 -> agent2 -- <task>\nOr: /chain agent1 \"task1\" -> agent2 \"task2\"", "info");
				return;
			}

			// Check for -- separator (shared task mode)
			const dashIdx = args.indexOf(" -- ");
			if (dashIdx !== -1) {
				const agentsPart = args.slice(0, dashIdx).trim();
				const task = args.slice(dashIdx + 4).trim();
				const agentNames = agentsPart.split(/\s*->\s*/).map((s) => s.trim()).filter(Boolean);

				if (agentNames.length < 2 || !task) {
					ctx.ui.notify("Usage: /chain agent1 -> agent2 -- <task>", "warning");
					return;
				}

				const steps = agentNames.map((name, i) => ({
					agent: name,
					task: i === 0 ? task : "{previous}",
				}));

				const stepsJson = JSON.stringify(steps);
				pi.sendUserMessage(
					`Use the subagent tool in chain mode with these steps: ${stepsJson}`,
					{ deliverAs: "followUp" },
				);
				return;
			}

			// Per-step task mode: agent1 "task1" -> agent2 "task2"
			const segments = args.split(/\s*->\s*/);
			const steps: { agent: string; task: string }[] = [];

			for (const seg of segments) {
				const parsed = parseQuotedArgs(seg.trim());
				if (parsed.length === 0) continue;
				const agent = parsed[0];
				const task = parsed.slice(1).join(" ") || (steps.length === 0 ? "" : "{previous}");
				steps.push({ agent, task });
			}

			if (steps.length < 2) {
				ctx.ui.notify("Chain needs at least 2 agents separated by ->", "warning");
				return;
			}

			if (!steps[0].task) {
				ctx.ui.notify("First step needs a task", "warning");
				return;
			}

			const stepsJson = JSON.stringify(steps);
			pi.sendUserMessage(
				`Use the subagent tool in chain mode with these steps: ${stepsJson}`,
				{ deliverAs: "followUp" },
			);
		},
	});

	// ─── /dispatch [task] ────────────────────────────────────────────────
	//
	// Executes work in the current worktree by decomposing a task into
	// parallel subtasks, or by executing the current worktree's .pi/plan.md.
	//

	pi.registerCommand("dispatch", {
		description: "Execute work in parallel: /dispatch [task]. No args = execute worktree-local .pi/plan.md or the plan from this session.",
		handler: async (args, ctx) => {
			const { agents } = discoverAgents(ctx.cwd, "both");
			const agentList = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
			const task = args?.trim();

			// With args: decompose and execute the given task
			if (task) {
				const dispatchPrompt = `Break this task into independent subtasks that can run in parallel, then execute them using the subagent tool in parallel mode (tasks array).

## Available agents
${agentList}

## Rules
- Identify 2-8 independent subtasks that don't depend on each other's output.
- Pick the best agent for each subtask (use "coder" for implementation, "scout" for analysis, "researcher" for research).
- If a subtask depends on another's output, DON'T parallelize those — either keep them together or use a chain for sequential dependencies.
- If the task is inherently sequential or atomic, just run it as a single subagent call instead.
- Each subtask should be self-contained with enough context to execute independently.

## Task
${task}`;
				pi.sendUserMessage(dispatchPrompt, { deliverAs: "followUp" });
				return;
			}

			// No args: look for .pi/plan.md first, then fall back to conversation
			const planFile = findPlanFile(ctx.cwd);

			if (planFile) {
				const dispatchPrompt = `Read the plan file at ${planFile} and execute it using the subagent tool.

## Available agents
${agentList}

## Instructions
1. Read ${planFile} to get the full plan.
2. Follow the **Execution Strategy** section to determine task ordering and parallelism.
3. For each parallel group, use the subagent tool's parallel mode (tasks array).
4. For sequential dependencies, use chain mode or run groups in sequence.
5. Each agent task description must be FULLY SELF-CONTAINED — copy all relevant context from the plan into each task. Agents cannot read the plan file or see this conversation.
6. Include file paths, function names, patterns to follow, and verification steps in each task.
7. Do NOT re-plan or discuss. Execute now.`;

				pi.sendUserMessage(dispatchPrompt, { deliverAs: "followUp" });
				return;
			}

			// No plan file: try to execute from conversation context
			const dispatchPrompt = `Look at the plan we've been discussing in this conversation. Execute it now using the subagent tool.

## Available agents
${agentList}

## Rules
- Review the plan from our conversation and identify the implementation steps.
- Break the plan into independent subtasks that can run in parallel (use the tasks array).
- Pick the best agent for each subtask (use "coder" for implementation, "scout" for analysis, "researcher" for research).
- If some steps depend on others, group the independent ones into a parallel batch, and use a chain for sequential dependencies.
- Each subtask must be self-contained — include all the relevant context, file paths, and requirements from our discussion so the agent can execute without seeing this conversation.
- Do NOT summarize or re-discuss the plan. Execute it now.

Tip: Consider running /plan first to create a .pi/plan.md for more reliable execution.`;

			pi.sendUserMessage(dispatchPrompt, { deliverAs: "followUp" });
		},
	});
}
