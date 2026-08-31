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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	getMarkdownTheme,
	ModelRuntime,
	parseFrontmatter,
	SessionManager,
	SettingsManager,
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { getGondolinToolProvider, type GondolinToolProvider } from "./gondolin/index.js";
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

type ChildState = "queued" | "running" | "completed" | "failed" | "aborted";

interface SingleResult {
	agent: string;
	task: string;
	state: ChildState;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinkingLevel?: string;
	stopReason?: string;
	errorMessage?: string;
	durationMs?: number;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
	jobId?: string;
	state?: JobState;
}

type JobState = "running" | "stopping" | "completed" | "failed" | "stopped";

interface AgentControl {
	send(message: string, delivery: "steer" | "followUp"): Promise<boolean>;
}

interface BackgroundJob {
	id: string;
	ownerSessionId: string;
	ownerSessionFile?: string;
	mode: SubagentDetails["mode"];
	state: JobState;
	createdAt: number;
	updatedAt: number;
	endedAt?: number;
	total: number;
	cwd: string;
	results: SingleResult[];
	controls: Map<number, AgentControl>;
	pendingInputs: Array<{ message: string; delivery: "steer" | "followUp"; index: number }>;
	deliveryFailures: string[];
	deliveryPromises: Set<Promise<void>>;
	abortController: AbortController;
	execution: Promise<void>;
	error?: string;
}

// ─── Output extraction ─────────────────────────────────────────────────────

function isFailedResult(result: SingleResult): boolean {
	return result.state === "failed" || result.state === "aborted";
}

function isTerminalResult(result: SingleResult): boolean {
	return result.state === "completed" || result.state === "failed" || result.state === "aborted";
}

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

class ChildLimiter {
	private active = 0;
	private readonly waiting: Array<{
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	constructor(private readonly limit: number) {}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("Subagent aborted while queued"));
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
			waiter.onAbort = () => {
				const index = this.waiting.indexOf(waiter);
				if (index >= 0) this.waiting.splice(index, 1);
				reject(new Error("Subagent aborted while queued"));
			};
			if (this.active < this.limit) {
				this.active++;
				resolve(this.makeRelease());
				return;
			}
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
			this.waiting.push(waiter);
		});
	}

	private makeRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.startNext();
		};
	}

	private startNext(): void {
		while (this.waiting.length > 0 && this.active < this.limit) {
			const waiter = this.waiting.shift()!;
			waiter.signal?.removeEventListener("abort", waiter.onAbort!);
			if (waiter.signal?.aborted) {
				waiter.reject(new Error("Subagent aborted while queued"));
				continue;
			}
			this.active++;
			waiter.resolve(this.makeRelease());
		}
	}
}

const childLimiter = new ChildLimiter(MAX_CONCURRENCY);

// ─── In-process Pi agent sessions ───────────────────────────────────────────

type OnUpdate = (partial: AgentToolResult<SubagentDetails>) => void;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_CHILD_TRANSCRIPT_BYTES = 16 * 1024;
let childModelRuntime: Promise<ModelRuntime> | undefined;

function parseAgentModel(value: string | undefined): { provider: string; modelId: string; thinking?: any } | undefined {
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	let modelId = value.slice(slash + 1);
	let thinking: any;
	const colon = modelId.lastIndexOf(":");
	if (colon > 0 && THINKING_LEVELS.has(modelId.slice(colon + 1))) {
		thinking = modelId.slice(colon + 1);
		modelId = modelId.slice(0, colon);
	}
	return { provider: value.slice(0, slash), modelId, thinking };
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function resolveAuthoritativeCwd(provider: GondolinToolProvider, defaultCwd: string, requestedCwd?: string): string {
	const hostCwd = canonicalPath(provider.hostCwd);
	const defaultHostCwd = defaultCwd === "/workspace" ? hostCwd : canonicalPath(defaultCwd);
	if (defaultHostCwd !== hostCwd) {
		throw new Error(`Gondolin is bound to ${provider.hostCwd}, not ${defaultCwd}; refusing to use another checkout`);
	}
	const requested = requestedCwd?.trim();
	if (!requested || requested === "/workspace") return provider.hostCwd;
	const resolved = canonicalPath(path.isAbsolute(requested) ? requested : path.resolve(provider.hostCwd, requested));
	if (resolved !== hostCwd) {
		throw new Error(`Requested cwd ${requested} does not map exactly to Gondolin workspace ${provider.hostCwd}`);
	}
	return provider.hostCwd;
}

async function getChildModelRuntime(ctx: ExtensionContext): Promise<ModelRuntime> {
	if (!childModelRuntime) childModelRuntime = ModelRuntime.create();
	const runtime = await childModelRuntime;
	for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
		const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
		const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
		if (nativeProvider) runtime.registerNativeProvider(nativeProvider);
		else if (config) runtime.registerProvider(providerId, config);
	}
	return runtime;
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value);
	if (bytes.byteLength <= maxBytes) return value;
	return `${bytes.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n[truncated]`;
}

function messageBytes(message: Message): number {
	try {
		return Buffer.byteLength(JSON.stringify(message));
	} catch {
		return MAX_CHILD_TRANSCRIPT_BYTES;
	}
}

function compactTranscriptMessage(message: Message): Message {
	if (messageBytes(message) <= MAX_CHILD_TRANSCRIPT_BYTES) return message;
	const text = "content" in message && Array.isArray(message.content)
		? message.content.flatMap((part: any) => {
				if (part.type === "text" && typeof part.text === "string") return [part.text];
				if (part.type === "toolCall") return [`[tool: ${String(part.name ?? "unknown")}]`];
				return [];
			}).join("\n")
		: "";
	return {
		role: message.role,
		content: [{ type: "text", text: truncateUtf8(text || "[oversized transcript entry omitted]", MAX_CHILD_TRANSCRIPT_BYTES - 1024) }],
		timestamp: (message as any).timestamp ?? Date.now(),
	} as Message;
}

function appendBoundedMessage(result: SingleResult, message: Message): void {
	result.messages.push(compactTranscriptMessage(message));
	let total = result.messages.reduce((sum, item) => sum + messageBytes(item), 0);
	while (result.messages.length > 1 && total > MAX_CHILD_TRANSCRIPT_BYTES) {
		total -= messageBytes(result.messages.shift()!);
	}
	if (result.messages.length === 1 && total > MAX_CHILD_TRANSCRIPT_BYTES) {
		result.messages[0] = compactTranscriptMessage(result.messages[0]);
	}
}

async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
	if (!session) return;
	try {
		if (!session.isIdle) {
			await Promise.race([
				session.abort(),
				new Promise<void>((resolve) => setTimeout(resolve, 5000)),
			]);
		}
	} catch {}
	session.dispose();
}

async function runAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	opts: {
		cwd?: string;
		step?: number;
		controlIndex?: number;
		signal?: AbortSignal;
		onUpdate?: OnUpdate;
		onStateChange?: (index: number, result: SingleResult) => void;
		onControlReady?: (index: number, control: AgentControl) => void;
		onControlClosed?: (index: number) => void;
		makeDetails: (results: SingleResult[]) => SubagentDetails;
		parentCtx: ExtensionContext;
	},
): Promise<SingleResult> {
	const agent = agents.find((candidate) => candidate.name === agentName);
	const result: SingleResult = {
		agent: agentName,
		task,
		state: "queued",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		step: opts.step,
	};
	const controlIndex = opts.controlIndex ?? (opts.step ? opts.step - 1 : 0);
	const startedAt = Date.now();
	let releaseSlot: (() => void) | undefined;
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let abortListener: (() => void) | undefined;
	let controlRegistered = false;

	const updateState = (state: ChildState) => {
		result.state = state;
		opts.onStateChange?.(controlIndex, result);
	};
	const emitUpdate = () => {
		opts.onStateChange?.(controlIndex, result);
		opts.onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(result.messages) || `(${result.state}…)` }],
			details: opts.makeDetails([result]),
		});
	};

	try {
		if (!agent) {
			throw new Error(`Unknown agent "${agentName}". Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`);
		}
		const provider = getGondolinToolProvider();
		if (!provider) throw new Error("Gondolin tool provider is unavailable; refusing to run an unsandboxed child");
		const effectiveCwd = resolveAuthoritativeCwd(provider, defaultCwd, opts.cwd);
		const requestedTools = agent.tools ?? ["read", "bash", "edit", "write"];
		const customTools = provider.tools.filter((tool) => requestedTools.includes(tool.name)) as ToolDefinition<any>[];
		const missingTools = requestedTools.filter((name) => !customTools.some((tool) => tool.name === name));
		if (missingTools.length > 0) throw new Error(`Gondolin does not provide required child tools: ${missingTools.join(", ")}`);

		releaseSlot = await childLimiter.acquire(opts.signal);
		if (opts.signal?.aborted) throw new Error("Subagent aborted before start");

		const modelSpec = parseAgentModel(agent.model);
		const model = modelSpec
			? opts.parentCtx.modelRegistry.find(modelSpec.provider, modelSpec.modelId)
			: opts.parentCtx.model;
		if (!model) throw new Error(modelSpec
			? `Configured model is unavailable: ${modelSpec.provider}/${modelSpec.modelId}`
			: "Parent session has no model selected");
		const modelRuntime = await getChildModelRuntime(opts.parentCtx);
		const settingsManager = SettingsManager.create(effectiveCwd, getAgentDir());
		const loader = new DefaultResourceLoader({
			cwd: effectiveCwd,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			appendSystemPromptOverride: (base) => [...base, agent.systemPrompt],
			extensionFactories: [{
				name: "subagent-gondolin-context",
				hidden: true,
				factory: (childPi) => {
					childPi.on("before_agent_start", (event) => {
						const hostLine = `Current working directory: ${provider.hostCwd}`;
						const guestLine = `Current working directory: /workspace (Gondolin VM; host workspace mounted from ${provider.hostCwd})`;
						return {
							systemPrompt: event.systemPrompt.includes(hostLine)
								? event.systemPrompt.replace(hostLine, guestLine)
								: `${event.systemPrompt}\n\n${guestLine}`,
						};
					});
				},
			}],
		});
		await loader.reload();

		const created = await createAgentSession({
			cwd: effectiveCwd,
			agentDir: getAgentDir(),
			model,
			thinkingLevel: modelSpec?.thinking ?? opts.parentCtx.thinkingLevel,
			modelRuntime,
			tools: requestedTools,
			customTools,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(effectiveCwd),
			settingsManager,
		});
		session = created.session;
		await session.bindExtensions({ mode: "print" });
		result.model = session.model ? `${session.model.provider}/${session.model.id}` : `${model.provider}/${model.id}`;
		result.thinkingLevel = session.thinkingLevel;
		updateState("running");
		emitUpdate();
		unsubscribe = session.subscribe((event: any) => {
			if (event.type === "agent_start" && !controlRegistered) {
				controlRegistered = true;
				opts.onControlReady?.(controlIndex, {
					async send(message, delivery) {
						if (!session?.isStreaming) return false;
						if (delivery === "followUp") await session.followUp(message);
						else await session.steer(message);
						return true;
					},
				});
			}
			if (event.type !== "message_end" || !event.message) return;
			const message = event.message as Message;
			if (message.role === "assistant" || message.role === "toolResult") appendBoundedMessage(result, message);
			if (message.role === "assistant") {
				result.usage.turns++;
				const usage = message.usage;
				if (usage) {
					result.usage.input += usage.input || 0;
					result.usage.output += usage.output || 0;
					result.usage.cacheRead += usage.cacheRead || 0;
					result.usage.cacheWrite += usage.cacheWrite || 0;
					result.usage.cost += usage.cost?.total || 0;
					result.usage.contextTokens = usage.totalTokens || 0;
				}
				if (message.stopReason) result.stopReason = message.stopReason;
				if (message.errorMessage) result.errorMessage = message.errorMessage;
			}
			emitUpdate();
		});

		const abort = () => { void session?.abort(); };
		if (opts.signal?.aborted) throw new Error("Subagent aborted before prompt");
		if (opts.signal) {
			opts.signal.addEventListener("abort", abort, { once: true });
			abortListener = () => opts.signal?.removeEventListener("abort", abort);
		}

		await session.prompt(`Task: ${task}`, { expandPromptTemplates: false });
		if (opts.signal?.aborted || result.stopReason === "aborted") {
			result.exitCode = 1;
			result.stopReason = "aborted";
			result.errorMessage ||= "Subagent stopped";
			updateState("aborted");
		} else if (result.stopReason === "error") {
			result.exitCode = 1;
			updateState("failed");
		} else {
			result.exitCode = 0;
			updateState("completed");
		}
	} catch (error) {
		result.exitCode = 1;
		result.errorMessage = error instanceof Error ? error.message : String(error);
		if (opts.signal?.aborted) {
			result.stopReason = "aborted";
			updateState("aborted");
		} else {
			updateState("failed");
		}
	} finally {
		result.durationMs = Date.now() - startedAt;
		abortListener?.();
		opts.onControlClosed?.(controlIndex);
		unsubscribe?.();
		await shutdownChildSession(session);
		releaseSlot?.();
		emitUpdate();
	}

	if (agent?.maxOutputLines) {
		for (let index = result.messages.length - 1; index >= 0; index--) {
			const message = result.messages[index];
			if (message.role !== "assistant") continue;
			for (const part of message.content) {
				if (part.type !== "text") continue;
				const lines = part.text.split("\n");
				if (lines.length > agent.maxOutputLines) {
					part.text = `${lines.slice(0, agent.maxOutputLines).join("\n")}\n\n[Truncated: ${lines.length} → ${agent.maxOutputLines} lines]`;
				}
			}
			break;
		}
	}
	return result;
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
	if (r.state === "queued") return theme.fg("muted", "○");
	if (r.state === "running") return theme.fg("warning", "●");
	if (isFailedResult(r)) return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function isRunning(r: SingleResult): boolean {
	return r.state === "running";
}

function renderCollapsedResult(r: SingleResult, theme: any): string {
	const icon = renderResultIcon(r, theme);
	const toolCalls = getToolCallSummary(r.messages);
	const output = getFinalOutput(r.messages);
	const duration = r.durationMs ? theme.fg("dim", ` ${formatDuration(r.durationMs)}`) : "";

	let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${duration}`;

	if (r.state === "queued") {
		text += ` ${theme.fg("muted", "(queued…)")}`;
	} else if (isRunning(r)) {
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
		action: Type.Optional(Type.Union([
			Type.Literal("launch"),
			Type.Literal("status"),
			Type.Literal("send"),
			Type.Literal("stop"),
		], { description: "Launch work, inspect background jobs, send input, or stop one. Defaults to launch." })),
		id: Type.Optional(Type.String({ description: "Background job id or unique id prefix" })),
		message: Type.Optional(Type.String({ description: "Input to send to an existing running subagent" })),
		delivery: Type.Optional(Type.Union([
			Type.Literal("steer"),
			Type.Literal("followUp"),
		], { description: "Deliver after the current turn (steer) or after current work settles (followUp). Default: steer." })),
		index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index; omit to send to all active children in the job" })),
		agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task (single mode)" })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run in parallel" })),
		chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain steps" })),
		cwd: Type.Optional(Type.String({ description: "Working directory" })),
	});

	const jobs = new Map<string, BackgroundJob>();
	let jobSequence = 0;
	let jobsFile = "";
	let currentCtx: ExtensionContext | null = null;
	let currentSessionId = "";
	let currentSessionFile: string | undefined;
	let progressTimer: ReturnType<typeof setInterval> | null = null;
	let completionTimer: ReturnType<typeof setTimeout> | null = null;
	let shuttingDown = false;
	let lastProgressFingerprint = "";
	const pendingCompletions = new Set<string>();
	const PROGRESS_INTERVAL_MS = 60_000;
	const MAX_RETAINED_JOBS = 30;
	const MAX_ACTIVE_JOBS = 20;
	const MAX_RETAINED_TRANSCRIPT_BYTES = 256 * 1024;
	const MAX_STATUS_OUTPUT_BYTES = 64 * 1024;

	function isCurrentOwner(job: BackgroundJob): boolean {
		return job.ownerSessionId === currentSessionId && job.ownerSessionFile === currentSessionFile;
	}

	function makePlaceholder(agent: string, task: string, step?: number): SingleResult {
		return {
			agent,
			task,
			state: "queued",
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
			step,
		};
	}

	function getLaunchShape(params: any): { mode: SubagentDetails["mode"]; total: number; results: SingleResult[] } {
		if (params.chain?.length) {
			return {
				mode: "chain",
				total: params.chain.length,
				results: params.chain.map((step: any, index: number) => makePlaceholder(step.agent, step.task, index + 1)),
			};
		}
		if (params.tasks?.length) {
			return {
				mode: "parallel",
				total: params.tasks.length,
				results: params.tasks.map((task: any) => makePlaceholder(task.agent, task.task)),
			};
		}
		return {
			mode: "single",
			total: 1,
			results: params.agent && params.task ? [makePlaceholder(params.agent, params.task)] : [],
		};
	}

	function jobCounts(job: BackgroundJob): { done: number; running: number; queued: number } {
		return {
			done: job.results.filter(isTerminalResult).length,
			running: job.results.filter((result) => result.state === "running").length,
			queued: job.results.filter((result) => result.state === "queued").length,
		};
	}

	function safeOneLine(value: string, max = 240): string {
		const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
		return clean.length > max ? `${clean.slice(0, max)}…` : clean;
	}

	function latestActivity(result: SingleResult): string {
		const calls = getToolCallSummary(result.messages);
		const call = calls[calls.length - 1];
		if (result.state === "queued") return "waiting for a process-wide slot";
		if (result.state === "running") return safeOneLine(call || "starting");
		if (isFailedResult(result)) return safeOneLine(result.errorMessage || result.stderr.trim() || result.state);
		const output = getFinalOutput(result.messages).trim().split("\n")[0];
		return safeOneLine(output || "completed");
	}

	function formatJobSummary(job: BackgroundJob): string {
		const { done, running, queued } = jobCounts(job);
		const duration = formatDuration((job.endedAt ?? Date.now()) - job.createdAt);
		return `${job.id} · ${job.state} · ${job.mode} · ${done}/${job.total} done${running ? ` · ${running} running` : ""}${queued ? ` · ${queued} queued` : ""} · ${duration}`;
	}

	function formatJob(job: BackgroundJob, includeOutput = false): string {
		const lines = [formatJobSummary(job)];
		for (const result of job.results) {
			const icon = result.state === "queued" ? "○" : result.state === "running" ? "●" : isFailedResult(result) ? "✗" : "✓";
			const step = result.step ? ` step ${result.step}` : "";
			lines.push(`${icon} ${result.agent}${step}: ${latestActivity(result).slice(0, 240)}`);
			if (includeOutput && result.exitCode !== -1) {
				const output = getFinalOutput(result.messages) || result.errorMessage || result.stderr;
				if (output.trim()) lines.push(truncateOutput(output.trim()));
			}
		}
		if (job.deliveryFailures.length > 0) lines.push(`Input delivery: ${job.deliveryFailures.slice(-3).join("; ")}`);
		if (job.error) lines.push(`Error: ${job.error}`);
		return truncateUtf8(lines.join("\n"), MAX_STATUS_OUTPUT_BYTES);
	}

	function activeJobs(): BackgroundJob[] {
		return [...jobs.values()].filter((job) =>
			(job.state === "running" || job.state === "stopping") && isCurrentOwner(job),
		);
	}

	function resolveJob(id: string | undefined): BackgroundJob | null {
		if (!id) return null;
		const exact = jobs.get(id);
		if (exact && isCurrentOwner(exact)) return exact;
		const matches = [...jobs.values()].filter((job) => isCurrentOwner(job) && job.id.startsWith(id));
		return matches.length === 1 ? matches[0] : null;
	}

	function writeJobsSnapshot(): void {
		if (!jobsFile) return;
		const active = activeJobs().map((job) => ({
			id: job.id,
			mode: job.mode,
			state: job.state,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			total: job.total,
			...jobCounts(job),
			agents: job.results.map((result) => ({
				name: safeOneLine(result.agent, 80),
				state: result.state,
				model: safeOneLine(result.model ?? "pending", 100),
				thinkingLevel: safeOneLine(result.thinkingLevel ?? "pending", 20),
				activity: latestActivity(result).slice(0, 240),
			})),
		}));
		const tempFile = `${jobsFile}.${process.pid}.${Date.now()}.tmp`;
		try {
			fs.writeFileSync(tempFile, JSON.stringify({ active, updatedAt: Date.now() }), {
				encoding: "utf-8",
				mode: 0o600,
				flag: "wx",
			});
			fs.renameSync(tempFile, jobsFile);
			fs.chmodSync(jobsFile, 0o600);
		} catch {
			try { fs.unlinkSync(tempFile); } catch {}
		}
	}

	function refreshWidget(): void {
		writeJobsSnapshot();
		if (!currentCtx?.hasUI) return;
		// Keep detailed progress in the right-hand status panel. Do not occupy the
		// above-editor area; only retain a compact footer status while jobs run.
		currentCtx.ui.setWidget("subagents", undefined);
		const active = activeJobs();
		currentCtx.ui.setStatus(
			"subagents",
			active.length > 0 ? `${active.length} job${active.length === 1 ? "" : "s"} active` : undefined,
		);
	}

	function sendCoordinatorMessage(ownerSessionId: string, ownerSessionFile: string | undefined, customType: string, text: string): void {
		if (shuttingDown || ownerSessionId !== currentSessionId || ownerSessionFile !== currentSessionFile) return;
		try {
			pi.sendMessage({
				customType,
				content: [{ type: "text", text }],
				display: false,
			}, { triggerTurn: true, deliverAs: "followUp" });
		} catch {
			// Session replacement can invalidate a background callback.
		}
	}

	function flushCompletions(): void {
		completionTimer = null;
		const completed = [...pendingCompletions]
			.map((id) => jobs.get(id))
			.filter((job): job is BackgroundJob => job !== undefined && isCurrentOwner(job));
		pendingCompletions.clear();
		if (completed.length === 0) return;
		const summaries = completed.map((job) => formatJob(job)).join("\n\n");
		const owner = completed[0]!;
		sendCoordinatorMessage(
			owner.ownerSessionId,
			owner.ownerSessionFile,
			"subagent-completion",
			`Background subagent work changed state. Inspect the relevant job with subagent action=status before reporting or accepting it.\n\n${summaries}`,
		);
	}

	function queueCompletion(job: BackgroundJob): void {
		if (shuttingDown || !isCurrentOwner(job)) return;
		pendingCompletions.add(job.id);
		if (!completionTimer) completionTimer = setTimeout(flushCompletions, 250);
	}

	function reportProgress(): void {
		const active = activeJobs();
		if (active.length === 0) return;
		const fingerprint = active.map((job) => `${job.id}:${job.updatedAt}`).join("|");
		if (fingerprint === lastProgressFingerprint) return;
		lastProgressFingerprint = fingerprint;
		const summaries = active.map((job) => formatJob(job)).join("\n\n");
		sendCoordinatorMessage(
			active[0].ownerSessionId,
			active[0].ownerSessionFile,
			"subagent-progress",
			`Background subagents are still active. Inspect them with subagent action=status and give the user a concise material-progress update.\n\n${summaries}`,
		);
	}

	function ensureProgressReporter(): void {
		if (!progressTimer) progressTimer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);
	}

	function stopProgressReporterIfIdle(): void {
		if (activeJobs().length > 0 || !progressTimer) return;
		clearInterval(progressTimer);
		progressTimer = null;
		lastProgressFingerprint = "";
	}

	function boundStatusOutput(text: string): string {
		return truncateUtf8(text, MAX_STATUS_OUTPUT_BYTES);
	}

	function recordDeliveryFailure(job: BackgroundJob, message: string): void {
		job.deliveryFailures.push(safeOneLine(message));
		if (job.deliveryFailures.length > 20) job.deliveryFailures.shift();
		job.updatedAt = Date.now();
		if (isCurrentOwner(job)) refreshWidget();
	}

	function trackDelivery(job: BackgroundJob, index: number, control: AgentControl, message: string, delivery: "steer" | "followUp"): void {
		let promise: Promise<void>;
		promise = control.send(message, delivery)
			.then((accepted) => {
				if (!accepted) recordDeliveryFailure(job, `child ${index} did not accept queued ${delivery} input`);
			})
			.catch((error) => {
				recordDeliveryFailure(job, `child ${index} queued ${delivery} failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => job.deliveryPromises.delete(promise));
		job.deliveryPromises.add(promise);
	}

	function markJobStopping(job: BackgroundJob, reason: string): void {
		if (job.state !== "running" && job.state !== "stopping") return;
		job.state = "stopping";
		job.abortController.abort();
		for (const input of job.pendingInputs) {
			recordDeliveryFailure(job, `child ${input.index} stopped before queued ${input.delivery} input was delivered`);
		}
		job.pendingInputs = [];
		job.updatedAt = Date.now();
	}

	function pruneJobs(): void {
		const terminal = [...jobs.values()]
			.filter((job) => job.state !== "running" && job.state !== "stopping")
			.sort((left, right) => left.updatedAt - right.updatedAt);
		let transcriptBytes = [...jobs.values()].reduce(
			(sum, job) => sum + job.results.reduce(
				(resultSum, result) => resultSum + result.messages.reduce((messageSum, message) => messageSum + messageBytes(message), 0),
				0,
			),
			0,
		);
		for (const job of terminal) {
			for (const result of job.results) {
				while (result.messages.length > 1 && transcriptBytes > MAX_RETAINED_TRANSCRIPT_BYTES) {
					transcriptBytes -= messageBytes(result.messages.shift()!);
				}
			}
		}
		while (jobs.size > MAX_RETAINED_JOBS && terminal.length > 0) {
			jobs.delete(terminal.shift()!.id);
		}
	}

	async function executeDispatch(
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdate | undefined,
		onStateChange: ((index: number, result: SingleResult) => void) | undefined,
		onControlReady: ((index: number, control: AgentControl) => void) | undefined,
		onControlClosed: ((index: number) => void) | undefined,
		ctx: ExtensionContext,
		agents: AgentConfig[],
	) {
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
				const results: SingleResult[] = params.chain.map((step: any, index: number) =>
					makePlaceholder(step.agent, step.task, index + 1),
				);
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
								if (cur) {
									results[i] = cur;
									onUpdate({ content: partial.content, details: makeDetails("chain")([...results]) });
								}
							}
						: undefined;

					const r = await runAgent(ctx.cwd, agents, step.agent, task, {
						cwd: step.cwd,
						step: i + 1,
						controlIndex: i,
						signal,
						onUpdate: chainOnUpdate,
						onStateChange,
						onControlReady,
						onControlClosed,
						makeDetails: makeDetails("chain"),
						parentCtx: ctx,
					});
					results[i] = r;

					if (isFailedResult(r)) {
						for (let pendingIndex = i + 1; pendingIndex < results.length; pendingIndex++) {
							results[pendingIndex] = {
								...results[pendingIndex],
								state: "aborted",
								exitCode: 1,
								stopReason: "aborted",
								errorMessage: "Chain stopped before this step",
							};
							onStateChange?.(pendingIndex, results[pendingIndex]);
						}
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

				const live: SingleResult[] = params.tasks.map((task: any) => makePlaceholder(task.agent, task.task));
				const emitParallel = () => {
					if (!onUpdate) return;
					const done = live.filter(isTerminalResult).length;
					onUpdate({
						content: [{ type: "text", text: `${done}/${params.tasks!.length} done` }],
						details: makeDetails("parallel")([...live]),
					});
				};
				const executions = params.tasks.map((task: any, index: number) =>
					runAgent(ctx.cwd, agents, task.agent, task.task, {
						cwd: task.cwd,
						controlIndex: index,
						signal,
						onUpdate: (partial) => {
							const current = partial.details?.results[0];
							if (current) live[index] = current;
							emitParallel();
						},
						onStateChange: (childIndex, result) => {
							live[childIndex] = result;
							onStateChange?.(childIndex, result);
						},
						onControlReady,
						onControlClosed,
						makeDetails: makeDetails("parallel"),
						parentCtx: ctx,
					}),
				);
				const settled = await Promise.allSettled(executions);
				const results = settled.map((outcome, index) => {
					if (outcome.status === "fulfilled") return outcome.value;
					return {
						...live[index],
						state: "failed" as const,
						exitCode: 1,
						errorMessage: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
					};
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
					controlIndex: 0,
					signal,
					onUpdate,
					onStateChange,
					onControlReady,
					onControlClosed,
					makeDetails: makeDetails("single"),
					parentCtx: ctx,
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
	}

	// ─── Subagent tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Agents",
		description: [
			"Launch specialized agents in the background so the main session remains responsive.",
			"Launch modes: single (agent + task), parallel (tasks[]), chain (steps with {previous}).",
			"Actions: launch (default), status, send (steer/follow-up input to running children), stop.",
			"After launch, return control to the user. Inspect active jobs on later turns and before accepting their work.",
			"Available agents are defined in ~/.pi/agent/agents/ and .pi/agents/ as markdown files.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;

			if (params.action === "status") {
				if (params.id) {
					const job = resolveJob(params.id);
					if (!job) {
						return { content: [{ type: "text", text: `No unique subagent job matches "${params.id}".` }], details: undefined, isError: true };
					}
					return { content: [{ type: "text", text: boundStatusOutput(formatJob(job, true)) }], details: undefined };
				}

				const ordered = [...jobs.values()]
					.filter(isCurrentOwner)
					.sort((left, right) => right.createdAt - left.createdAt);
				const visible = [
					...ordered.filter((job) => job.state === "running" || job.state === "stopping"),
					...ordered.filter((job) => job.state !== "running" && job.state !== "stopping").slice(0, 10),
				];
				return {
					content: [{ type: "text", text: visible.length > 0
						? boundStatusOutput(visible.map(formatJobSummary).join("\n"))
						: "No subagent jobs have run in this session." }],
					details: undefined,
				};
			}

			if (params.action === "send") {
				const job = resolveJob(params.id);
				const message = params.message?.trim();
				if (!job || job.state !== "running") {
					return { content: [{ type: "text", text: "Sending input requires a running job id." }], details: undefined, isError: true };
				}
				if (!message) {
					return { content: [{ type: "text", text: "Sending input requires a non-empty message." }], details: undefined, isError: true };
				}
				const messagePreview = safeOneLine(message, 160);
				if (params.index !== undefined && params.index >= job.total) {
					return { content: [{ type: "text", text: `Child index ${params.index} is outside this ${job.total}-child job.` }], details: undefined, isError: true };
				}
				const untargetedChainIndex = job.mode === "chain" && params.index === undefined
					? [...job.controls.keys()][0] ?? job.results.findIndex((result) => result.state === "queued")
					: undefined;
				const targetIndex = params.index ?? (untargetedChainIndex !== undefined && untargetedChainIndex >= 0 ? untargetedChainIndex : undefined);
				const targets = targetIndex === undefined
					? [...job.controls.entries()]
					: job.controls.has(targetIndex) ? [[targetIndex, job.controls.get(targetIndex)!] as const] : [];
				if (targets.length === 0) {
					const queuedIndices = targetIndex !== undefined
						? [targetIndex]
						: job.results.map((result, index) => result.state === "queued" ? index : -1).filter((index) => index >= 0);
					if (queuedIndices.length === 0) {
						recordDeliveryFailure(job, `no child accepted ${params.delivery ?? "steer"} input`);
						return { content: [{ type: "text", text: `No active or queued child in ${job.id} can accept the input. Message: “${messagePreview}”` }], details: undefined, isError: true };
					}
					for (const index of queuedIndices) {
						job.pendingInputs.push({ message, delivery: params.delivery ?? "steer", index });
					}
					job.updatedAt = Date.now();
					refreshWidget();
					return { content: [{ type: "text", text: `Queued ${params.delivery ?? "steer"} input for ${queuedIndices.length} child${queuedIndices.length === 1 ? "" : "ren"} in ${job.id}. Message: “${messagePreview}”` }], details: undefined };
				}
				const deliveryResults = await Promise.all(
					targets.map(async ([index, control]) => ({
						index,
						accepted: await control.send(message, params.delivery ?? "steer").catch(() => false),
					})),
				);
				const delivered = deliveryResults.filter((result) => result.accepted);
				for (const result of deliveryResults) {
					if (!result.accepted) recordDeliveryFailure(job, `child ${result.index} did not accept ${params.delivery ?? "steer"} input`);
				}
				job.updatedAt = Date.now();
				refreshWidget();
				return {
					content: [{ type: "text", text: delivered.length > 0
						? `Sent ${params.delivery ?? "steer"} input to ${delivered.length}/${targets.length} active child${targets.length === 1 ? "" : "ren"} in ${job.id}. Message: “${messagePreview}”`
						: `No active child in ${job.id} accepted the input. Message: “${messagePreview}”` }],
					details: undefined,
					isError: delivered.length === 0,
				};
			}

			if (params.action === "stop") {
				const job = resolveJob(params.id);
				if (!job) {
					return { content: [{ type: "text", text: "Stopping a job requires an exact or unique id prefix." }], details: undefined, isError: true };
				}
				if (job.state !== "running") {
					return { content: [{ type: "text", text: `${job.id} is already ${job.state}.` }], details: undefined };
				}
				markJobStopping(job, "Subagent stopped by coordinator");
				refreshWidget();
				return { content: [{ type: "text", text: `Stop requested for ${job.id}.` }], details: undefined };
			}

			const { agents } = discoverAgents(ctx.cwd, "both");
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
				const list = agents.map((agent) => `${agent.name}: ${agent.description}`).join("\n");
				return {
					content: [{ type: "text", text: `Provide exactly one launch mode (single/parallel/chain), or action=status|stop.\n\nAvailable agents:\n${list || "none"}` }],
					details: undefined,
					isError: true,
				};
			}
			if (hasTasks && params.tasks!.length > MAX_PARALLEL) {
				return { content: [{ type: "text", text: `Max ${MAX_PARALLEL} parallel tasks` }], details: undefined, isError: true };
			}
			if (activeJobs().length >= MAX_ACTIVE_JOBS) {
				return { content: [{ type: "text", text: `Max ${MAX_ACTIVE_JOBS} active background jobs` }], details: undefined, isError: true };
			}
			const gondolinProvider = getGondolinToolProvider();
			if (!gondolinProvider) {
				return { content: [{ type: "text", text: "Gondolin is unavailable; refusing to launch unsandboxed subagents." }], details: undefined, isError: true };
			}
			try {
				resolveAuthoritativeCwd(gondolinProvider, ctx.cwd, params.cwd);
				for (const item of [...(params.tasks ?? []), ...(params.chain ?? [])]) {
					resolveAuthoritativeCwd(gondolinProvider, ctx.cwd, item.cwd);
				}
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: undefined,
					isError: true,
				};
			}
			const requestedAgents = hasChain
				? params.chain!.map((step) => step.agent)
				: hasTasks ? params.tasks!.map((task) => task.agent) : [params.agent!];
			const unknownAgents = [...new Set(requestedAgents.filter((name) => !agents.some((agent) => agent.name === name)))];
			if (unknownAgents.length > 0) {
				return {
					content: [{ type: "text", text: `Unknown agent(s): ${unknownAgents.join(", ")}. Available: ${agents.map((agent) => agent.name).join(", ") || "none"}` }],
					details: undefined,
					isError: true,
				};
			}

			const shape = getLaunchShape(params);
			const job: BackgroundJob = {
				id: `agent-${Date.now().toString(36)}-${++jobSequence}`,
				ownerSessionId: ctx.sessionManager.getSessionId(),
				ownerSessionFile: ctx.sessionManager.getSessionFile(),
				mode: shape.mode,
				state: "running",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				total: shape.total,
				cwd: gondolinProvider.hostCwd,
				results: shape.results,
				controls: new Map(),
				pendingInputs: [],
				deliveryFailures: [],
				deliveryPromises: new Set(),
				abortController: new AbortController(),
				execution: Promise.resolve(),
			};
			jobs.set(job.id, job);
			ensureProgressReporter();
			refreshWidget();

			const dispatch = executeDispatch(
				params,
				job.abortController.signal,
				undefined,
				(index, result) => {
					job.results[index] = job.state === "stopping" && !isTerminalResult(result)
						? { ...result, state: "aborted", exitCode: 1, stopReason: "aborted", errorMessage: "Subagent stopping" }
						: result;
					job.updatedAt = Date.now();
					if (isCurrentOwner(job)) refreshWidget();
				},
				(index, control) => {
					job.controls.set(index, control);
					const pending = job.pendingInputs.filter((input) => input.index === index);
					job.pendingInputs = job.pendingInputs.filter((input) => input.index !== index);
					for (const input of pending) trackDelivery(job, index, control, input.message, input.delivery);
					job.updatedAt = Date.now();
					if (isCurrentOwner(job)) refreshWidget();
				},
				(index) => {
					job.controls.delete(index);
					job.updatedAt = Date.now();
					if (isCurrentOwner(job)) refreshWidget();
				},
				ctx,
				agents,
			);
			job.execution = dispatch.then(async (result) => {
				if (result.details?.results) job.results = result.details.results;
				await Promise.allSettled([...job.deliveryPromises]);
				for (const input of job.pendingInputs) {
					recordDeliveryFailure(job, `child ${input.index} finished before queued ${input.delivery} input was delivered`);
				}
				job.pendingInputs = [];
				job.state = job.abortController.signal.aborted
					? "stopped"
					: result.isError || job.results.some(isFailedResult) ? "failed" : "completed";
			}).catch((error) => {
				job.state = job.abortController.signal.aborted ? "stopped" : "failed";
				job.error = error instanceof Error ? error.message : String(error);
			}).finally(() => {
				job.endedAt = Date.now();
				job.updatedAt = job.endedAt;
				if (isCurrentOwner(job)) refreshWidget();
				stopProgressReporterIfIdle();
				queueCompletion(job);
				pruneJobs();
			});

			return {
				content: [{ type: "text", text: `Started ${job.id} in the background (${shape.mode}, ${shape.total} task${shape.total === 1 ? "" : "s"}). Return control to the user now. Use action=status to inspect it; do not wait or poll tightly.` }],
				details: { mode: shape.mode, results: shape.results, jobId: job.id, state: "running" } satisfies SubagentDetails,
			};
		},

		// ── Render: tool call header ──
		renderCall(args, theme) {
			if (args.action) {
				const target = args.id ? ` ${args.id}` : "";
				return new Text(`${theme.fg("toolTitle", theme.bold("agents "))}${theme.fg("accent", args.action)}${theme.fg("dim", target)}`, 0, 0);
			}
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
			const running = details.results.filter((r) => r.state === "running").length;
			const queued = details.results.filter((r) => r.state === "queued").length;
			const done = details.results.filter(isTerminalResult).length;
			const headerIcon = running > 0 || queued > 0
				? theme.fg("warning", "●")
				: ok === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const status = running > 0 || queued > 0
				? `${done}/${details.results.length} done${running ? `, ${running} running` : ""}${queued ? `, ${queued} queued` : ""}`
				: `${ok}/${details.results.length}`;

			let text = `${headerIcon} ${theme.fg("toolTitle", theme.bold(modeLabel))} ${theme.fg("accent", status)} ${theme.fg("dim", formatDuration(totalDuration))}`;
			for (const r of details.results) {
				const ri = renderResultIcon(r, theme);
				const stepLabel = r.step ? `Step ${r.step}: ` : "";
				const duration = r.durationMs ? theme.fg("dim", ` ${formatDuration(r.durationMs)}`) : "";

				if (r.state === "queued") {
					text += `\n${ri} ${theme.fg("muted", stepLabel)}${theme.fg("accent", r.agent)} ${theme.fg("muted", "(queued…)")}`;
				} else if (isRunning(r)) {
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

	// ─── Background job lifecycle ─────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		currentCtx = ctx;
		currentSessionId = ctx.sessionManager.getSessionId();
		currentSessionFile = ctx.sessionManager.getSessionFile();
		const sessionDir = currentSessionFile ? path.dirname(currentSessionFile) : path.join(os.tmpdir(), `pi-session-${process.pid}`);
		try { fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 }); } catch {}
		jobsFile = path.join(sessionDir, `${process.pid}-subagents.json`);
		refreshWidget();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		const active = activeJobs();
		if (active.length === 0) return;
		return {
			message: {
				customType: "subagent-status-reminder",
				content: `${active.length} background subagent job${active.length === 1 ? " is" : "s are"} active. Inspect them with subagent action=status before answering the user, and report only material changes.`,
				display: false,
			},
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		if (progressTimer) clearInterval(progressTimer);
		if (completionTimer) clearTimeout(completionTimer);
		progressTimer = null;
		completionTimer = null;
		pendingCompletions.clear();
		const ownerSessionId = ctx.sessionManager.getSessionId();
		const ownerSessionFile = ctx.sessionManager.getSessionFile();
		const ownedJobs = [...jobs.values()].filter((job) =>
			job.ownerSessionId === ownerSessionId && job.ownerSessionFile === ownerSessionFile,
		);
		for (const job of ownedJobs) markJobStopping(job, "Parent session shut down");
		await Promise.allSettled(ownedJobs.map((job) => job.execution));
		for (const job of ownedJobs) {
			for (let index = 0; index < job.results.length; index++) {
				if (isTerminalResult(job.results[index])) continue;
				job.results[index] = {
					...job.results[index],
					state: "aborted",
					exitCode: 1,
					stopReason: "aborted",
					errorMessage: "Parent session cleanup timed out",
				};
			}
			job.state = "stopped";
			job.endedAt ??= Date.now();
			jobs.delete(job.id);
		}
		try { if (jobsFile) fs.unlinkSync(jobsFile); } catch {}
		jobsFile = "";
		if (ctx.hasUI) {
			ctx.ui.setWidget("subagents", undefined);
			ctx.ui.setStatus("subagents", undefined);
		}
		currentCtx = null;
		currentSessionId = "";
		currentSessionFile = undefined;
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
