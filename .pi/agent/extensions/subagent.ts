/**
 * Subagent extension — lightweight multi-agent orchestration for pi.
 *
 * Based on pi's built-in subagent example, enhanced with:
 *   - subagent tool — single/parallel/chain launch modes, background jobs, and status/send/stop control
 *   - Duration + cost tracking
 *   - Output truncation to avoid context blowup
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, StringEnum, type Message } from "@earendil-works/pi-ai";
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
	SettingsManager,
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { getGondolinToolProvider, type GondolinToolProvider } from "./lib/gondolin-provider.js";
import permissionGate from "./permission-gate.js";
import protectedPaths from "./protected-paths.js";
import {
	AUTO_POLICIES,
	CatalogRefreshCoordinator,
	mergeModelPolicy,
	modelCandidates,
	resolveModelSelection,
	THINKING_LEVELS,
	waitWithDeadline,
	type ModelPolicy,
} from "./lib/model-selection.js";
import { cleanGeneratedSessionName, heuristicSessionName, sanitizeTitleText } from "./lib/session-title.js";
import {
	childDetail,
	createChildSession,
	detailPage,
	finishInspection,
	inspectionActivity,
	newInspection,
	openChildSession,
	savedChildSessions,
	showInspector,
	terminalText,
	trackChildEvent,
	type ChildInspection,
} from "./lib/subagent-inspector.js";

// ─── Agent discovery ────────────────────────────────────────────────────────

type AgentScope = "user" | "project" | "both";

interface AgentConfig extends ModelPolicy {
	name: string;
	description: string;
	tools?: string[];
	maxOutputLines?: number;
	maxTurns?: number;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function positiveInteger(value: unknown): number | undefined {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
			thinking: frontmatter.thinking,
			provider: frontmatter.provider,
			family: frontmatter.family,
			maxOutputLines: frontmatter.maxOutputLines ? Number(frontmatter.maxOutputLines) : undefined,
			maxTurns: positiveInteger(frontmatter.maxTurns),
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

function discoverAgents(cwd: string, scope: AgentScope, projectTrusted: boolean): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	// Untrusted projects must not advertise or override agents, including from ancestor dirs.
	const projectAgentsDir = projectTrusted && scope !== "user" ? findNearestProjectAgentsDir(cwd) : null;

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Project agents override user agents with the same name
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	if (scope !== "user") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

function formatAgentCatalogForPrompt(agents: AgentConfig[]): string {
	if (agents.length === 0) {
		return [
			"## Subagents",
			"No subagent definitions are discovered in ~/.pi/agent/agents/ or .pi/agents/.",
			"The subagent tool's single/parallel/chain launch modes have no valid agent names to use right now.",
		].join("\n");
	}
	const lines = agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
	return [
		"## Subagents",
		"Available agents (name: description):",
		lines,
		"For the subagent tool's single/parallel/chain launch modes, choose only the exact names listed above; do not invent names or aliases.",
	].join("\n");
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TITLE_MAX_WORDS = 6;
const TITLE_MAX_CHARS = 48;
const TITLE_PROMPT_CHARS = 1000;
const TITLE_TIMEOUT_MS = 5000;
const MAX_TURNS_GRACE = 3;
const TURN_LIMIT_MESSAGE = "You have reached your turn limit. Do not start new work. Give your final answer now with what you have, and say what is unfinished.";

// ─── Limits ─────────────────────────────────────────────────────────────────

interface SubagentLimits {
	/** Parallel tasks in one launch. */
	maxTasksPerLaunch: number;
	/** Children running at once across all jobs in this process. */
	maxConcurrent: number;
	maxActiveJobs: number;
	/** Turn cap for agents without frontmatter `maxTurns`. */
	defaultMaxTurns: number;
}

const DEFAULT_LIMITS: SubagentLimits = { maxTasksPerLaunch: 8, maxConcurrent: 4, maxActiveJobs: 20, defaultMaxTurns: 80 };
const LIMIT_CEILINGS: SubagentLimits = { maxTasksPerLaunch: 32, maxConcurrent: 16, maxActiveJobs: 100, defaultMaxTurns: 1000 };

/** Reads the `subagents` settings object; project settings count only when the project is trusted. */
function loadSubagentLimits(cwd: string, projectTrusted: boolean): { limits: SubagentLimits; warnings: string[] } {
	const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted }).getSettings() as Record<string, unknown>;
	const config = settings.subagents;
	const limits = { ...DEFAULT_LIMITS };
	if (config === undefined) return { limits, warnings: [] };
	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		return { limits, warnings: ["`subagents` must be an object; using default limits"] };
	}
	const warnings: string[] = [];
	for (const [key, value] of Object.entries(config)) {
		if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
			warnings.push(`unknown key subagents.${key} ignored`);
			continue;
		}
		const name = key as keyof SubagentLimits;
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LIMIT_CEILINGS[name]) {
			warnings.push(`subagents.${key} must be an integer from 1 to ${LIMIT_CEILINGS[name]}; using ${DEFAULT_LIMITS[name]}`);
			continue;
		}
		limits[name] = value;
	}
	return { limits, warnings };
}

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
	agentType: string;
	sessionName: string;
	task: string;
	state: ChildState;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinkingLevel?: string;
	selectionReason?: string;
	stopReason?: string;
	errorMessage?: string;
	durationMs?: number;
	step?: number;
	inspection?: ChildInspection;
	sessionFile?: string;
	sessionSaved?: boolean;
	persistenceError?: string;
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
	/** Last parent-observed update per child; the inspection clock covers events that skip updates. */
	lastUpdateAt: Map<number, number>;
	/** Activity timestamp each child's stall notice was sent for, so one quiet spell wakes the parent once. */
	stallNoticeFor: Map<number, number>;
	deliveryFailures: string[];
	deliveryPromises: Set<Promise<void>>;
	abortController: AbortController;
	execution: Promise<void>;
	error?: string;
	/** Stopped by parent shutdown or session replacement, so children stay resumable. */
	parentInterrupted?: boolean;
}

/** What the parent session records about each child it launches. */
interface ChildLaunch {
	agent: string;
	task: string;
	cwd: string;
	/** Launch and per-task model overrides; the agent definition supplies the rest at resume time. */
	policy: ModelPolicy;
	sessionFile?: string;
}

type ChildRecordEntry =
	| ({ kind: "launch"; parentSessionId: string; jobId: string; index: number } & ChildLaunch)
	| { kind: "session"; jobId: string; index: number; sessionFile: string }
	| { kind: "end"; jobId: string; index: number; state: string; stopReason?: string };

interface ChildRecord extends ChildLaunch {
	jobId: string;
	index: number;
	/** Set once the child reached a terminal state or was resumed; unset means interrupted unless still live. */
	state?: string;
	stopReason?: string;
}

const CHILD_RECORD_ENTRY = "subagent-child";
const MAX_RECORD_TASK_BYTES = 2048;
const DEFAULT_RESUME_MESSAGE = "You were interrupted. Continue the task from where you left off and give your final answer.";

// ─── Output extraction ─────────────────────────────────────────────────────

function isFailedResult(result: SingleResult): boolean {
	return result.state === "failed" || result.state === "aborted";
}

function isTerminalResult(result: SingleResult): boolean {
	return result.state === "completed" || result.state === "failed" || result.state === "aborted";
}

function compactState(state: ChildState): "queued" | "running" | "done" | "failed" | "stopped" {
	if (state === "completed") return "done";
	if (state === "aborted") return "stopped";
	return state;
}

function safeOneLine(value: string, max = 240): string {
	const clean = sanitizeTitleText(value).replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function formatChildIdentity(result: SingleResult): string {
	const title = safeOneLine(result.sessionName || "Subagent Task", 80);
	const type = safeOneLine(result.agentType || result.agent || "agent", 40);
	const model = safeOneLine(result.model ?? "model pending", 120);
	const thinking = safeOneLine(result.thinkingLevel ?? "pending", 20);
	return `${title} [${type}] · ${model} · thinking ${thinking}`;
}

function compactHeaderLine(result: SingleResult, max = 240): string {
	const name = safeOneLine(result.sessionName || "Subagent Task", 64);
	const type = safeOneLine(result.agentType || result.agent || "agent", 40);
	const state = compactState(result.state);
	const model = safeOneLine(result.model ?? "model pending", 120);
	const thinking = safeOneLine(result.thinkingLevel ?? "pending", 20);
	return safeOneLine(`${name} · ${type} · ${state} · ${model} · ${thinking}`, max);
}

function compactActionsLine(result: SingleResult, max = 240): string | null {
	if (result.inspection) return safeOneLine(inspectionActivity(result.inspection), max);
	const calls = getToolCallSummary(result.messages)
		.map((call) => safeOneLine(call, 60))
		.filter(Boolean);
	if (calls.length === 0) return null;
	const recent = calls.slice(-3);
	const line = safeOneLine(recent.join(" · "), max);
	return line.length > 0 ? line : null;
}

function latestActivity(result: SingleResult): string {
	const actions = compactActionsLine(result, 240);
	if (actions) return actions;
	if (isFailedResult(result)) return safeOneLine(result.errorMessage || result.stderr.trim() || result.state);
	if (result.state === "completed") {
		const output = getFinalOutput(result.messages).trim().split("\n")[0];
		return safeOneLine(output || "completed");
	}
	return compactState(result.state);
}

function formatAgentList(results: SingleResult[]): string[] {
	const lines: string[] = [];
	for (const result of results) {
		lines.push(compactHeaderLine(result, 240));
		const actions = compactActionsLine(result, 240);
		if (actions) lines.push(`  ${actions}`);
	}
	return lines;
}

function diagnosticParts(result: SingleResult): string[] {
	const parts: string[] = [];
	if (result.stopReason && result.stopReason !== "stop") parts.push(result.stopReason);
	if (result.errorMessage?.trim()) parts.push(result.errorMessage.trim());
	if (result.stderr.trim()) parts.push(result.stderr.trim());
	return parts;
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

	constructor(private limit: number) {}

	setLimit(limit: number): void {
		this.limit = limit;
		this.startNext();
	}

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

const childLimiter = new ChildLimiter(DEFAULT_LIMITS.maxConcurrent);

// ─── In-process Pi agent sessions ───────────────────────────────────────────

type OnUpdate = (partial: AgentToolResult<SubagentDetails>) => void;

const MAX_CHILD_TRANSCRIPT_BYTES = 16 * 1024;
const catalogRefreshers = new WeakMap<ExtensionContext["modelRegistry"], CatalogRefreshCoordinator>();

async function refreshModelCatalog(ctx: ExtensionContext, policy: ModelPolicy, signal?: AbortSignal): Promise<{ notice?: string }> {
	const candidates = policy.model === undefined ? [] : modelCandidates(policy.model);
	if (!candidates.some((candidate) => AUTO_POLICIES.some((name) => candidate === `auto:${name}`))) {
		const error = ctx.modelRegistry.getError();
		return { notice: error ? `catalog may be stale (${error})` : undefined };
	}
	let refresher = catalogRefreshers.get(ctx.modelRegistry);
	if (!refresher) {
		refresher = new CatalogRefreshCoordinator();
		catalogRefreshers.set(ctx.modelRegistry, refresher);
	}
	return refresher.refresh(ctx.modelRegistry, !process.env.PI_OFFLINE, signal);
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function resolveAuthoritativeCwd(provider: GondolinToolProvider | undefined, defaultCwd: string, requestedCwd?: string): string {
	if (!provider) return path.resolve(defaultCwd, requestedCwd?.trim() || ".");
	const hostCwd = canonicalPath(provider.hostCwd);
	const defaultHostCwd = defaultCwd === "/workspace" ? hostCwd : canonicalPath(defaultCwd);
	if (defaultHostCwd !== hostCwd) {
		throw new Error(`Gondolin is bound to ${provider.hostCwd}, not ${defaultCwd}; refusing to use another checkout`);
	}
	const requested = requestedCwd?.trim();
	if (!requested || requested === "/workspace") return provider.hostCwd;
	const resolved = canonicalPath(path.isAbsolute(requested) ? requested : path.resolve(provider.hostCwd, requested));
	if (resolved !== hostCwd) {
		throw new Error(`Requested cwd ${requested} does not map exactly to Gondolin workspace ${provider.hostCwd}; omit cwd or use /workspace`);
	}
	return provider.hostCwd;
}

/** Missing trust APIs fail closed: project resources stay unloaded. */
function isParentProjectTrusted(ctx: ExtensionContext): boolean {
	return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
}

/** A child inherits project trust only for the parent's own workspace, compared canonically. */
function isChildProjectTrusted(ctx: ExtensionContext, provider: GondolinToolProvider | undefined, effectiveCwd: string): boolean {
	if (!isParentProjectTrusted(ctx)) return false;
	const parentCwd = provider && ctx.cwd === "/workspace" ? provider.hostCwd : ctx.cwd;
	return canonicalPath(effectiveCwd) === canonicalPath(parentCwd);
}

function projectAgentTrustError(agent: AgentConfig, projectTrusted: boolean, cwd: string): string | undefined {
	if (agent.source !== "project" || projectTrusted) return undefined;
	return `Project agent "${agent.name}" cannot run in ${cwd}: project agents only run in the trusted parent workspace. Omit cwd or use a user agent.`;
}

async function getChildModelRuntime(ctx: ExtensionContext, signal?: AbortSignal): Promise<ModelRuntime> {
	// A fresh runtime avoids stale registrations and cross-parent routing. Keep
	// compatibility registrations intact: effective providers omit model headers.
	const runtime = await ModelRuntime.create({ refreshOnCreate: false, signal });
	signal?.throwIfAborted();
	for (const registeredId of ctx.modelRegistry.getRegisteredProviderIds()) {
		const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(registeredId);
		const config = ctx.modelRegistry.getRegisteredProviderConfig(registeredId);
		if (nativeProvider) runtime.registerNativeProvider(nativeProvider);
		else if (config) runtime.registerProvider(registeredId, config);
	}
	return runtime;
}

async function selectRefinementModel(ctx: ExtensionContext, signal?: AbortSignal) {
	const selection = await waitWithDeadline(
		(titleSignal) => resolveModelSelection({
			policy: { model: "auto:cheap", thinking: "low" },
			availableModels: ctx.modelRegistry.getAvailable(),
			allModels: ctx.modelRegistry.getAll(),
			parentModel: ctx.model,
			parentThinkingLevel: ctx.thinkingLevel,
			authenticate: async (candidate) => {
				const auth = await waitWithDeadline(
					() => ctx.modelRegistry.getApiKeyAndHeaders(candidate),
					{ signal: titleSignal, timeoutMs: TITLE_TIMEOUT_MS, label: "Subagent naming model auth" },
				);
				return auth.ok ? { ok: true as const } : { ok: false as const, error: auth.error };
			},
			getSupportedThinkingLevels,
			clampThinkingLevel,
			signal: titleSignal,
			timeoutMs: TITLE_TIMEOUT_MS,
		}),
		{ signal, timeoutMs: TITLE_TIMEOUT_MS, label: "Subagent naming model selection" },
	);
	return selection.model;
}

async function refineSessionName(ctx: ExtensionContext, task: string, signal?: AbortSignal): Promise<string | null> {
	const model = await selectRefinementModel(ctx, signal);
	const registry = ctx.modelRegistry as any;
	if (typeof registry.complete !== "function") return null;
	const promptText = task.length > TITLE_PROMPT_CHARS ? `${task.slice(0, TITLE_PROMPT_CHARS)}…` : task;
	const response = await waitWithDeadline(
		(titleSignal) => registry.complete(model, {
			systemPrompt: "You name coding-agent sessions. Reply with ONLY a short Title Case name, 2 to 6 words. No quotes, no punctuation, no explanation.",
			messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
		}, { signal: titleSignal }),
		{ signal, timeoutMs: TITLE_TIMEOUT_MS, label: "Subagent naming completion" },
	);
	if (!response || response.stopReason === "error" || response.stopReason === "aborted") return null;
	const textParts = Array.isArray(response.content)
		? response.content.filter((part: any): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text)
		: [];
	const raw = textParts.join(" ").trim();
	if (!raw) return null;
	return cleanGeneratedSessionName(raw, { maxWords: TITLE_MAX_WORDS, maxChars: TITLE_MAX_CHARS });
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
		launchPolicy?: ModelPolicy;
		itemPolicy?: ModelPolicy;
		defaultMaxTurns: number;
		/** Continue a saved child session with this message instead of starting the task. */
		resume?: { sessionFile: string; message: string };
		signal?: AbortSignal;
		onUpdate?: OnUpdate;
		onStateChange?: (index: number, result: SingleResult) => void;
		onControlReady?: (index: number, control: AgentControl) => void;
		onControlClosed?: (index: number) => void;
		canApplyAsync?: () => boolean;
		makeDetails: (results: SingleResult[]) => SubagentDetails;
		parentCtx: ExtensionContext;
	},
): Promise<SingleResult> {
	const agent = agents.find((candidate) => candidate.name === agentName);
	const result: SingleResult = {
		agent: agentName,
		agentType: agentName,
		sessionName: heuristicSessionName(task, { maxWords: TITLE_MAX_WORDS, maxChars: TITLE_MAX_CHARS }) ?? "Subagent Task",
		task,
		state: "queued",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		step: opts.step,
		inspection: newInspection(),
	};
	const controlIndex = opts.controlIndex ?? (opts.step ? opts.step - 1 : 0);
	const startedAt = Date.now();
	let releaseSlot: (() => void) | undefined;
	let session: AgentSession | undefined;
	let childSession: ReturnType<typeof createChildSession> | undefined;
	let lastEventUpdate = 0;
	let unsubscribe: (() => void) | undefined;
	let abortListener: (() => void) | undefined;
	let controlRegistered = false;
	let titleController: AbortController | undefined;
	let titleTimer: ReturnType<typeof setTimeout> | undefined;
	let parentTitleAbortListener: (() => void) | undefined;
	let turnCount = 0;
	let turnLimitSteered = false;
	let turnLimitError: string | undefined;

	const updateState = (state: ChildState) => {
		result.state = state;
		opts.onStateChange?.(controlIndex, result);
	};
	let outputCapped = false;
	// The terminal state change snapshots the completion for the parent, so cap first.
	const finishState = (state: ChildState) => {
		if (agent?.maxOutputLines && !outputCapped) {
			outputCapped = true;
			capFinalOutput(result.messages, agent.maxOutputLines);
		}
		updateState(state);
	};
	const emitUpdate = () => {
		if (result.sessionFile) result.sessionSaved = fs.existsSync(result.sessionFile);
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
		const effectiveCwd = resolveAuthoritativeCwd(provider, defaultCwd, opts.cwd);
		const projectTrusted = isChildProjectTrusted(opts.parentCtx, provider, effectiveCwd);
		const trustError = projectAgentTrustError(agent, projectTrusted, effectiveCwd);
		if (trustError) throw new Error(trustError);
		const requestedTools = agent.tools ?? ["read", "bash", "edit", "write"];
		const customTools = provider?.tools.filter((tool) => requestedTools.includes(tool.name)) as ToolDefinition<any>[] | undefined;
		if (provider) {
			const missingTools = requestedTools.filter((name) => !customTools?.some((tool) => tool.name === name));
			if (missingTools.length > 0) throw new Error(`Gondolin does not provide required child tools: ${missingTools.join(", ")}`);
		}

		releaseSlot = await childLimiter.acquire(opts.signal);
		if (opts.signal?.aborted) throw new Error("Subagent aborted before start");

		const policy = mergeModelPolicy(agent, opts.launchPolicy, opts.itemPolicy);
		const refresh = await refreshModelCatalog(opts.parentCtx, policy, opts.signal);
		const selection = await resolveModelSelection({
			policy,
			availableModels: opts.parentCtx.modelRegistry.getAvailable(),
			allModels: opts.parentCtx.modelRegistry.getAll(),
			parentModel: opts.parentCtx.model,
			parentThinkingLevel: opts.parentCtx.thinkingLevel,
			authenticate: async (candidate) => {
				const auth = await opts.parentCtx.modelRegistry.getApiKeyAndHeaders(candidate);
				return auth.ok ? { ok: true as const } : { ok: false as const, error: auth.error };
			},
			getSupportedThinkingLevels,
			clampThinkingLevel,
			catalogNotice: refresh.notice,
			signal: opts.signal,
		});
		opts.signal?.throwIfAborted();
		const model = selection.model;
		result.model = `${model.provider}/${model.id}`;
		result.thinkingLevel = selection.thinkingLevel;
		const overrideSources = Object.entries(policy.sources)
			.filter(([, source]) => source !== "agent")
			.map(([field, source]) => `${field} from ${source}`);
		result.selectionReason = `${selection.reason}${overrideSources.length > 0 ? `; ${overrideSources.join(", ")}` : ""}`;
		if (!projectTrusted && isParentProjectTrusted(opts.parentCtx)) {
			result.selectionReason += "; project resources not loaded: cwd is outside the trusted parent workspace";
		}
		const modelRuntime = await waitWithDeadline((signal) => getChildModelRuntime(opts.parentCtx, signal), {
			signal: opts.signal,
			label: "Child model runtime setup",
		});
		opts.signal?.throwIfAborted();
		const settingsManager = SettingsManager.create(effectiveCwd, getAgentDir(), { projectTrusted });
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
			// noExtensions skips discovery only; inline factories still load, so children keep the default guards.
			extensionFactories: [
				{ name: "permission-gate", factory: permissionGate },
				{ name: "protected-paths", factory: protectedPaths },
				...(provider ? [{
					name: "subagent-gondolin-context",
					hidden: true,
					factory: (childPi: ExtensionAPI) => {
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
				}] : []),
			],
		});
		await loader.reload();
		opts.signal?.throwIfAborted();

		const ownerId = opts.parentCtx.sessionManager.getSessionId();
		const ownerFile = opts.parentCtx.sessionManager.getSessionFile();
		try {
			childSession = opts.resume
				? openChildSession(opts.resume.sessionFile, effectiveCwd, ownerId, ownerFile)
				: createChildSession(effectiveCwd, ownerId, ownerFile);
			result.sessionFile = childSession.getSessionFile();
		} catch (error) {
			result.persistenceError = `Cannot ${opts.resume ? "open" : "create"} native child session: ${error instanceof Error ? error.message : String(error)}`;
			throw new Error(result.persistenceError);
		}
		if (opts.resume) result.sessionName = childSession.getSessionName() ?? result.sessionName;
		const created = await createAgentSession({
			cwd: effectiveCwd,
			agentDir: getAgentDir(),
			model,
			thinkingLevel: selection.thinkingLevel as any,
			modelRuntime,
			tools: requestedTools,
			customTools,
			resourceLoader: loader,
			sessionManager: childSession,
			settingsManager,
		});
		session = created.session;
		opts.signal?.throwIfAborted();
		await session.bindExtensions({ mode: "print" });
		session.setSessionName(result.sessionName);
		titleController = new AbortController();
		titleTimer = setTimeout(() => titleController?.abort(), TITLE_TIMEOUT_MS);
		if (opts.signal) {
			const onParentAbort = () => titleController?.abort();
			opts.signal.addEventListener("abort", onParentAbort, { once: true });
			parentTitleAbortListener = () => opts.signal?.removeEventListener("abort", onParentAbort);
		}
		// A resumed child keeps the name its session already has.
		if (!opts.resume) void refineSessionName(opts.parentCtx, task, titleController.signal)
			.then((refined) => {
				if (!refined || !session) return;
				if (opts.signal?.aborted || isTerminalResult(result)) return;
				if (opts.canApplyAsync && !opts.canApplyAsync()) return;
				result.sessionName = refined;
				session.setSessionName(refined);
				emitUpdate();
			})
			.catch((error) => {
				if (titleController?.signal.aborted || opts.signal?.aborted || isTerminalResult(result)) return;
				const message = error instanceof Error ? error.message : String(error);
				result.stderr = `${result.stderr}${result.stderr ? "\n" : ""}Title refinement failed: ${message}`;
				emitUpdate();
			})
			.finally(() => {
				if (titleTimer) clearTimeout(titleTimer);
				titleTimer = undefined;
			});
		result.model = session.model ? `${session.model.provider}/${session.model.id}` : `${model.provider}/${model.id}`;
		if (session.thinkingLevel !== result.thinkingLevel) {
			result.selectionReason += `; session clamped thinking ${result.thinkingLevel} to ${session.thinkingLevel}`;
		}
		result.thinkingLevel = session.thinkingLevel;
		updateState("running");
		emitUpdate();
		const maxTurns = agent.maxTurns ?? opts.defaultMaxTurns;
		const recordControlError = (label: string, error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			result.stderr = `${result.stderr}${result.stderr ? "\n" : ""}${label} failed: ${message}`;
		};
		unsubscribe = session.subscribe((event: any) => {
			if (event.type === "turn_end") {
				turnCount++;
				if (!turnLimitSteered && turnCount >= maxTurns) {
					turnLimitSteered = true;
					session?.steer(TURN_LIMIT_MESSAGE).catch((error) => recordControlError("Turn limit steer", error));
				} else if (turnLimitSteered && !turnLimitError && turnCount >= maxTurns + MAX_TURNS_GRACE) {
					turnLimitError = `Turn limit reached: stopped after ${turnCount} turns (limit ${maxTurns} plus ${MAX_TURNS_GRACE} to wrap up)`;
					session?.abort().catch((error) => recordControlError("Turn limit abort", error));
				}
			}
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
			const changed = trackChildEvent(result.inspection!, event);
			if (event.type !== "message_end" || !event.message) {
				// Streaming events update the inspector immediately; limit disk/sidebar writes.
				if (changed && (event.type !== "message_update" && event.type !== "tool_execution_update" || Date.now() - lastEventUpdate >= 500)) {
					lastEventUpdate = Date.now();
					emitUpdate();
				}
				return;
			}
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

		await session.prompt(opts.resume ? opts.resume.message : `Task: ${task}`, { expandPromptTemplates: false });
		if (turnLimitError && !opts.signal?.aborted) {
			// Keep the transcript so the parent still gets the partial final output.
			result.exitCode = 1;
			result.stopReason = "turn limit reached";
			result.errorMessage = turnLimitError;
			finishState("failed");
		} else if (opts.signal?.aborted || result.stopReason === "aborted") {
			result.exitCode = 1;
			result.stopReason = "aborted";
			result.errorMessage ||= "Subagent stopped";
			finishState("aborted");
		} else if (result.stopReason === "error") {
			result.exitCode = 1;
			finishState("failed");
		} else {
			result.exitCode = 0;
			finishState("completed");
		}
	} catch (error) {
		result.exitCode = 1;
		result.errorMessage = error instanceof Error ? error.message : String(error);
		if (opts.signal?.aborted) {
			result.stopReason = "aborted";
			finishState("aborted");
		} else {
			if (turnLimitError) result.stopReason = "turn limit reached";
			finishState("failed");
		}
	} finally {
		result.durationMs = Date.now() - startedAt;
		abortListener?.();
		if (titleTimer) clearTimeout(titleTimer);
		titleTimer = undefined;
		titleController?.abort();
		parentTitleAbortListener?.();
		opts.onControlClosed?.(controlIndex);
		unsubscribe?.();
		await shutdownChildSession(session);
		if (childSession) {
			try {
				childSession.appendCustomEntry("subagent-outcome", { state: result.state, error: result.errorMessage });
				result.sessionSaved = Boolean(result.sessionFile && fs.existsSync(result.sessionFile));
			} catch (error) {
				result.persistenceError = `Native session may be incomplete: ${error instanceof Error ? error.message : String(error)}`;
				result.errorMessage = result.persistenceError;
				result.state = "failed";
				result.exitCode = 1;
			}
		}
		if (result.inspection) finishInspection(result.inspection);
		releaseSlot?.();
		emitUpdate();
	}

	return result;
}

/** Replaces the final assistant message with a capped copy; the child session keeps the original. */
function capFinalOutput(messages: Message[], maxLines: number): void {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		messages[index] = {
			...message,
			content: message.content.map((part) => {
				if (part.type !== "text") return part;
				const lines = part.text.split("\n");
				if (lines.length <= maxLines) return part;
				return { ...part, text: `${lines.slice(0, maxLines).join("\n")}\n\n[Truncated: ${lines.length} → ${maxLines} lines]` };
			}),
		};
		return;
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
	if (r.state === "queued") return theme.fg("muted", "○");
	if (r.state === "running") return theme.fg("warning", "●");
	if (isFailedResult(r)) return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function isRunning(r: SingleResult): boolean {
	return r.state === "running";
}

function selectionSummary(r: SingleResult): string {
	if (!r.model) return "model selection pending";
	return `${r.model} · thinking ${r.thinkingLevel ?? "pending"}${r.selectionReason ? ` · ${r.selectionReason}` : ""}`;
}

const COLLAPSED_STATUS_CHILD_LIMIT = 3;
const COLLAPSED_STATUS_MAX_BYTES = 2048;

function firstTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string") {
			return (part as any).text;
		}
	}
	return "";
}

function summarizeStatusCounts(results: SingleResult[]): string {
	const counts: Record<ReturnType<typeof compactState>, number> = {
		queued: 0,
		running: 0,
		done: 0,
		failed: 0,
		stopped: 0,
	};
	for (const result of results) counts[compactState(result.state)]++;
	const parts = [`${results.length} child${results.length === 1 ? "" : "ren"}`];
	for (const state of ["running", "queued", "done", "failed", "stopped"] as const) {
		if (!counts[state]) continue;
		parts.push(`${counts[state]} ${state}`);
	}
	return parts.join(" · ");
}

function statusDiagnostics(statusText: string, details: SubagentDetails | undefined): string[] {
	const fromStatus = statusText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^(input delivery:|error:|PERSISTENCE ERROR:)/i.test(line));
	if (fromStatus.length > 0) return fromStatus.map((line) => safeOneLine(line, 220));
	if (!details) return [];
	const fallback: string[] = [];
	for (const result of details.results) {
		if (!isFailedResult(result)) continue;
		const parts = diagnosticParts(result);
		if (parts.length === 0) continue;
		const label = safeOneLine(result.sessionName || result.agent || "child", 40);
		fallback.push(`${label}: ${safeOneLine(parts.join("; "), 170)}`);
		if (fallback.length >= 2) break;
	}
	return fallback;
}

function renderCollapsedStatus(
	statusText: string,
	details: SubagentDetails | undefined,
	view: "summary" | "detail" | undefined,
	theme: any,
): string {
	const lines: string[] = [];
	if (view === "detail") {
		const header = safeOneLine(statusText.split("\n").find((line) => line.trim().length > 0) ?? "Status detail", 180);
		lines.push(`${theme.fg("toolTitle", theme.bold("status detail"))} ${theme.fg("muted", header)}`);
		for (const diagnostic of statusDiagnostics(statusText, details).slice(0, 2)) lines.push(theme.fg("error", diagnostic));
		lines.push(theme.fg("dim", "Expand to view the detail page."));
		return truncateUtf8(lines.join("\n"), COLLAPSED_STATUS_MAX_BYTES);
	}

	if (!details || details.results.length === 0) {
		const summary = safeOneLine(statusText || "(no output)", 220);
		lines.push(`${theme.fg("toolTitle", theme.bold("status"))} ${theme.fg("muted", summary)}`);
		if (statusText.includes("\n")) lines.push(theme.fg("dim", "Expand for full status output."));
		return truncateUtf8(lines.join("\n"), COLLAPSED_STATUS_MAX_BYTES);
	}

	lines.push(`${theme.fg("toolTitle", theme.bold("status"))} ${theme.fg("muted", summarizeStatusCounts(details.results))}`);
	for (const child of details.results.slice(0, COLLAPSED_STATUS_CHILD_LIMIT)) {
		lines.push(`${renderResultIcon(child, theme)} ${theme.fg("dim", compactHeaderLine(child, 180))}`);
	}
	if (details.results.length > COLLAPSED_STATUS_CHILD_LIMIT) {
		lines.push(theme.fg("dim", `… ${details.results.length - COLLAPSED_STATUS_CHILD_LIMIT} more children`));
	}
	for (const diagnostic of statusDiagnostics(statusText, details).slice(0, 2)) lines.push(theme.fg("error", diagnostic));
	lines.push(theme.fg("dim", "Expand for full status output."));
	return truncateUtf8(lines.join("\n"), COLLAPSED_STATUS_MAX_BYTES);
}

function renderCollapsedResult(r: SingleResult, theme: any): string {
	const icon = renderResultIcon(r, theme);
	const name = sanitizeTitleText(r.sessionName || "Subagent Task") || "Subagent Task";
	const type = sanitizeTitleText(r.agentType || r.agent || "agent") || "agent";
	const model = sanitizeTitleText(r.model ?? "model pending") || "model pending";
	const thinking = sanitizeTitleText(r.thinkingLevel ?? "pending") || "pending";
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("muted", "·")} ${theme.fg("accent", type)} ${theme.fg("muted", "·")} ${theme.fg("accent", compactState(r.state))} ${theme.fg("muted", "·")} ${theme.fg("dim", model)} ${theme.fg("muted", "·")} ${theme.fg("dim", thinking)}`;
	const actions = compactActionsLine(r, 180);
	if (actions) text += `\n${theme.fg("dim", actions)}`;
	return text;
}

function renderExpandedResult(r: SingleResult, theme: any): Container {
	const c = new Container();
	const icon = renderResultIcon(r, theme);
	const duration = r.durationMs ? ` ${formatDuration(r.durationMs)}` : "";
	const title = sanitizeTitleText(r.sessionName || "Subagent Task") || "Subagent Task";
	const type = sanitizeTitleText(r.agentType || r.agent || "agent") || "agent";
	const modelThinking = `${sanitizeTitleText(r.model ?? "model pending")} · thinking ${sanitizeTitleText(r.thinkingLevel ?? "pending")}`;
	c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("accent", `[${type}]`)}${theme.fg("dim", duration)}`, 0, 0));
	c.addChild(new Text(theme.fg("dim", modelThinking), 0, 0));

	if (r.exitCode !== 0 && r.errorMessage) {
		c.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	if (r.model) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("muted", "─── Model selection ───"), 0, 0));
		c.addChild(new Text(theme.fg("dim", selectionSummary(r)), 0, 0));
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

	const usage = formatUsage(r.usage);
	if (usage) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}

	return c;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ─── Tool schemas ─────────────────────────────────────────────────────

	const CWD_DESCRIPTION = "Working directory. Omit to inherit the parent workspace. Under Gondolin, omit or use /workspace; other paths are rejected.";
	const ModelPolicyFields = {
		model: Type.Optional(Type.String({ description: "Model policy (auto:cheap|auto:balanced|auto:strong) or provider/model[:thinking] pin, or a comma-separated fallback list of them; the first available candidate wins" })),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Requested thinking level" })),
		provider: Type.Optional(Type.String({ description: "Exact provider constraint" })),
		family: Type.Optional(Type.String({ description: "Normalized model-family token sequence constraint, such as claude-opus" })),
	};

	const TaskItem = Type.Object({
		agent: Type.String({ description: "Agent name" }),
		task: Type.String({ description: "Task to delegate" }),
		cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
		...ModelPolicyFields,
	});

	const ChainItem = Type.Object({
		agent: Type.String({ description: "Agent name" }),
		task: Type.String({ description: "Task with optional {previous} placeholder" }),
		cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
		...ModelPolicyFields,
	});

	const SubagentParams = Type.Object({
		action: Type.Optional(Type.Union([
			Type.Literal("launch"),
			Type.Literal("status"),
			Type.Literal("send"),
			Type.Literal("stop"),
			Type.Literal("resume"),
		], { description: "Launch work, inspect background jobs, send input, stop one, or resume an interrupted child. Defaults to launch." })),
		id: Type.Optional(Type.String({ description: "Background job id or unique id prefix" })),
		view: Type.Optional(StringEnum(["summary", "detail"] as const, { description: "status detail requires id and index; bounded 16KiB transcript page, no thinking content" })),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset returned by the previous detail page; default 0" })),
		message: Type.Optional(Type.String({ description: "Input to send to an existing running subagent, or the first message for a resumed one" })),
		delivery: Type.Optional(Type.Union([
			Type.Literal("steer"),
			Type.Literal("followUp"),
		], { description: "Deliver after the current turn (steer) or after current work settles (followUp). Default: steer." })),
		index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index; omit to send to all active children in the job. Required for resume." })),
		agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task (single mode)" })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run in parallel" })),
		chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain steps" })),
		cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
		...ModelPolicyFields,
	});

	const jobs = new Map<string, BackgroundJob>();
	let jobSequence = 0;
	let jobsFile = "";
	let currentCtx: ExtensionContext | null = null;
	let currentSessionId = "";
	let currentSessionFile: string | undefined;
	let stallTimer: ReturnType<typeof setInterval> | null = null;
	let completionTimer: ReturnType<typeof setTimeout> | null = null;
	let shuttingDown = false;
	let inspectorController: AbortController | undefined;
	let limits: SubagentLimits = { ...DEFAULT_LIMITS };
	/** Settings problems not yet shown; without a UI they ride along with the next launch result. */
	let pendingLimitWarning: string | undefined;
	const pendingCompletions = new Set<string>();
	/** Children recorded in the current session's branch, keyed like completions. */
	const childRecords = new Map<string, ChildRecord>();
	const pendingCompletionSnapshots = new Map<string, { jobId: string; index: number; result: SingleResult }>();
	/** Sent but not yet seen in the parent session; Pi may drop a queued message, so the snapshot stays. */
	const sentCompletions = new Set<string>();
	const deliveredCompletions = new Set<string>();
	const groupStragglerTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const stragglerDueJobs = new Set<string>();
	const STALL_NOTICE_MS = 10 * 60_000;
	const STALL_CHECK_MS = 60_000;
	const GROUP_STRAGGLER_MS = 2 * 60_000;
	const SHUTDOWN_WAIT_MS = 10_000;
	const MAX_RETAINED_JOBS = 30;
	const MAX_RETAINED_TRANSCRIPT_BYTES = 256 * 1024;
	const MAX_STATUS_OUTPUT_BYTES = 64 * 1024;
	const COMPLETION_MESSAGE = "subagent-completion";

	function isCurrentOwner(job: BackgroundJob): boolean {
		return job.ownerSessionId === currentSessionId && job.ownerSessionFile === currentSessionFile;
	}

	function modelPolicyFrom(value: any): ModelPolicy {
		const optional = (field: unknown) => field === "" ? undefined : field;
		return {
			model: optional(value?.model) as string | undefined,
			thinking: value?.thinking,
			provider: optional(value?.provider) as string | undefined,
			family: optional(value?.family) as string | undefined,
		};
	}

	function overridePolicy(launch: ModelPolicy, item: ModelPolicy): ModelPolicy {
		const { sources: _sources, ...policy } = mergeModelPolicy({}, launch, item);
		return policy;
	}

	function applyChildRecord(entry: ChildRecordEntry): void {
		const key = completionKey(entry.jobId, entry.index);
		if (entry.kind === "launch") {
			const { kind: _kind, parentSessionId: _parentSessionId, ...record } = entry;
			childRecords.set(key, record);
			return;
		}
		const record = childRecords.get(key);
		if (!record) return;
		if (entry.kind === "session") record.sessionFile = entry.sessionFile;
		else {
			record.state = entry.state;
			record.stopReason = entry.stopReason;
		}
	}

	function appendChildRecord(job: BackgroundJob, entry: ChildRecordEntry): void {
		if (shuttingDown || !isCurrentOwner(job)) return;
		try {
			pi.appendEntry(CHILD_RECORD_ENTRY, entry);
		} catch (error) {
			recordDeliveryFailure(job, `child ${entry.index} ${entry.kind} record not saved: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		applyChildRecord(entry);
	}

	/** Records the child's session file once known and its terminal state, unless the parent interrupted it. */
	function syncChildRecord(job: BackgroundJob, index: number, result: SingleResult): void {
		const record = childRecords.get(completionKey(job.id, index));
		if (!record || record.state !== undefined) return;
		if (result.sessionFile && record.sessionFile !== result.sessionFile) {
			appendChildRecord(job, { kind: "session", jobId: job.id, index, sessionFile: result.sessionFile });
		}
		if (isTerminalResult(result) && !job.parentInterrupted) {
			appendChildRecord(job, { kind: "end", jobId: job.id, index, state: result.state, stopReason: result.stopReason });
		}
	}

	/** Forked sessions copy the entries, so only records made by this session id count. */
	function restoreChildRecords(ctx: ExtensionContext): void {
		childRecords.clear();
		const sessionId = ctx.sessionManager.getSessionId();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== CHILD_RECORD_ENTRY) continue;
			const data = entry.data as ChildRecordEntry | undefined;
			if (!data || typeof data.jobId !== "string" || !Number.isInteger(data.index)) continue;
			if (data.kind === "launch" && data.parentSessionId !== sessionId) continue;
			applyChildRecord(data);
		}
	}

	function interruptedChildren(): ChildRecord[] {
		return [...childRecords.values()].filter((record) => {
			if (record.state !== undefined) return false;
			const job = jobs.get(record.jobId);
			return !job || !isCurrentOwner(job) || (job.state !== "running" && job.state !== "stopping");
		});
	}

	function formatInterrupted(record: ChildRecord): string {
		return safeOneLine(`${record.jobId} [${record.index}] ${record.task} · ${record.agent} · interrupted`, 240);
	}

	function interruptedDetail(record: ChildRecord): string {
		const saved = record.sessionFile && fs.existsSync(record.sessionFile);
		return terminalText([
			`job ${record.jobId} · child ${record.index} · interrupted`,
			`agent: ${record.agent}`,
			`cwd: ${record.cwd}`,
			`model overrides: ${JSON.stringify(record.policy)}`,
			`native session (${saved ? "file exists; read-only" : "no saved transcript"}): ${record.sessionFile ?? "not allocated"}`,
			"The parent session ended while this child was unfinished. It does not restart on its own.",
			saved
				? `Resume with subagent action=resume id=${record.jobId} index=${record.index} and an optional message.`
				: "It stopped before saving a transcript, so it can't be resumed; launch the task again.",
			"\nTask (first 2 KB):",
			record.task,
		].join("\n"));
	}

	function makePlaceholder(agent: string, task: string, step?: number): SingleResult {
		const fallbackName = heuristicSessionName(task, { maxWords: TITLE_MAX_WORDS, maxChars: TITLE_MAX_CHARS }) ?? `Task ${step ?? 1}`;
		return {
			agent,
			agentType: agent,
			sessionName: fallbackName,
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

	function formatJob(job: BackgroundJob, includeOutput = false): string {
		const lines = formatAgentList(job.results);
		if (includeOutput) {
			for (const result of job.results) {
				if (result.sessionFile) lines.push(`  native session (${result.sessionSaved ? "file exists; read-only" : "pending; no saved transcript yet"}): ${terminalText(result.sessionFile)}`);
				if (!isTerminalResult(result)) continue;
				const output = getFinalOutput(result.messages).trim();
				const error = diagnosticParts(result).join("; ");
				if (output) lines.push(`  output: ${safeOneLine(output, 500)}`);
				if (error) lines.push(`  error: ${safeOneLine(error, 500)}`);
			}
		}
		if (job.deliveryFailures.length > 0) lines.push(`input delivery: ${job.deliveryFailures.slice(-3).join("; ")}`);
		if (job.error) lines.push(`error: ${safeOneLine(job.error, 500)}`);
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
				sessionName: safeOneLine(result.sessionName || "Subagent Task", 80),
				agentType: safeOneLine(result.agentType || result.agent, 40),
				identity: safeOneLine(formatChildIdentity(result), 240),
				name: safeOneLine(result.agent, 80),
				state: result.state,
				model: safeOneLine(result.model ?? "pending", 120),
				thinkingLevel: safeOneLine(result.thinkingLevel ?? "pending", 20),
				activity: latestActivity(result).slice(0, 240),
				lastActivityAt: result.inspection?.lastActivityAt,
				action: result.inspection?.tools.filter((tool) => tool.endedAt === undefined).map((tool) => safeOneLine(`${tool.name} ${tool.args}`, 160)).join(" · "),
			})),
		}));
		const interrupted = interruptedChildren().map((record) => ({
			jobId: record.jobId,
			index: record.index,
			agentType: safeOneLine(record.agent, 40),
			state: "interrupted",
			task: safeOneLine(record.task, 160),
		}));
		const tempFile = `${jobsFile}.${process.pid}.${Date.now()}.tmp`;
		try {
			fs.writeFileSync(tempFile, JSON.stringify({ active, interrupted, updatedAt: Date.now() }), {
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
		// Keep agent progress only in the right-hand status panel.
		currentCtx.ui.setWidget("subagents", undefined);
		currentCtx.ui.setStatus("subagents", undefined);
	}

	function sendCoordinatorMessage(ownerSessionId: string, ownerSessionFile: string | undefined, customType: string, text: string, wake = true, details?: unknown): boolean {
		if (shuttingDown || ownerSessionId !== currentSessionId || ownerSessionFile !== currentSessionFile) return false;
		try {
			pi.sendMessage({
				customType,
				content: [{ type: "text", text }],
				display: false,
				details,
			}, { triggerTurn: wake, deliverAs: "followUp" });
			return true;
		} catch {
			// Session replacement can invalidate a background callback.
			return false;
		}
	}

	function boundCoordinatorOutput(text: string): string {
		const bytes = Buffer.from(text);
		if (bytes.byteLength <= MAX_STATUS_OUTPUT_BYTES) return text;
		const keep = Math.max(0, MAX_STATUS_OUTPUT_BYTES - 160);
		return `${bytes.subarray(0, keep).toString("utf8")}\n\n[Truncated coordinator update: showing first ${keep} of ${bytes.byteLength} bytes]`;
	}

	function completionKey(jobId: string, index: number): string {
		return `${jobId}:${index}`;
	}

	function cloneResultSnapshot(result: SingleResult): SingleResult {
		let messages: Message[] = [];
		try {
			messages = JSON.parse(JSON.stringify(result.messages)) as Message[];
		} catch {
			messages = [];
		}
		return {
			...result,
			messages,
			usage: { ...result.usage },
		};
	}

	function boundCompletionBlock(text: string, maxBytes: number): string {
		const bytes = Buffer.from(text);
		if (bytes.byteLength <= maxBytes) return text;
		const keep = Math.max(0, maxBytes - 192);
		return `${bytes.subarray(0, keep).toString("utf8")}\n\n[Child completion truncated. Use subagent action=status view=detail with id and index; the native session holds the full transcript.]`;
	}

	function formatChildCompletion(job: BackgroundJob, index: number, result: SingleResult, maxBytes: number): string {
		const step = result.step ? `step ${result.step}` : `child ${index + 1}/${job.total}`;
		const output = (getFinalOutput(result.messages) || "").trim() || "(no output)";
		const errors = diagnosticParts(result).map((part) => safeOneLine(part, 500));
		const lines = [
			`${job.id} · ${job.mode} · ${step}`,
			`identity: ${formatChildIdentity(result)}`,
			`state: ${result.state}`,
			`native session (${result.sessionSaved ? "file exists; read-only" : "pending; no saved transcript yet"}): ${result.sessionFile ?? "not allocated"}`,
			`usage: ${formatUsage(result.usage) || "none"}`,
			"output:",
			output,
		];
		if (errors.length > 0) {
			lines.push("error:");
			lines.push(errors.join("; "));
		}
		return boundCompletionBlock(lines.join("\n"), maxBytes);
	}

	/** Multi-task jobs wake the parent once when every child is done, or for parallel stragglers. */
	function completionGroupReady(job: BackgroundJob): boolean {
		if (job.total <= 1 || job.results.every(isTerminalResult)) return true;
		return job.mode === "parallel" && stragglerDueJobs.has(job.id);
	}

	/** Finished intermediate chain steps only feed the next step; report the final answer and failures. */
	function reportsCompletion(job: BackgroundJob, index: number, result: SingleResult): boolean {
		if (job.mode !== "chain" || job.total <= 1) return true;
		if (isFailedResult(result)) return result.stopReason !== "skipped";
		return index === job.total - 1;
	}

	function clearGroupStraggler(jobId: string): void {
		const timer = groupStragglerTimers.get(jobId);
		if (timer) clearTimeout(timer);
		groupStragglerTimers.delete(jobId);
		stragglerDueJobs.delete(jobId);
	}

	function clearGroupStragglers(): void {
		for (const timer of groupStragglerTimers.values()) clearTimeout(timer);
		groupStragglerTimers.clear();
		stragglerDueJobs.clear();
	}

	/** On shutdown, held completions are appended to the transcript without starting a turn. */
	function flushCompletions(final = false): void {
		if (completionTimer) clearTimeout(completionTimer);
		completionTimer = null;
		const pendingKeys = [...pendingCompletions];
		pendingCompletions.clear();
		const groups = new Map<string, { job: BackgroundJob; keys: string[] }>();
		for (const key of pendingKeys) {
			if (deliveredCompletions.has(key)) continue;
			const snap = pendingCompletionSnapshots.get(key);
			if (!snap) continue;
			const job = jobs.get(snap.jobId);
			if (!job || !isCurrentOwner(job)) continue;
			if (!final && !completionGroupReady(job)) {
				pendingCompletions.add(key);
				continue;
			}
			if (!(final ? snap.result.stopReason !== "skipped" : reportsCompletion(job, snap.index, snap.result))) {
				deliveredCompletions.add(key);
				pendingCompletionSnapshots.delete(key);
				continue;
			}
			const group = groups.get(job.id) ?? { job, keys: [] };
			group.keys.push(key);
			groups.set(job.id, group);
		}

		const separator = "\n\n---\n\n";
		const maxBytes = MAX_STATUS_OUTPUT_BYTES;
		// Size each block so a job's group fits one message, and pack whole groups so a job wakes the parent once.
		type Batch = { ownerSessionId: string; ownerSessionFile?: string; jobs: BackgroundJob[]; keys: string[]; text: string };
		const batches: Batch[] = [];
		let current: Batch | null = null;
		for (const { job, keys } of groups.values()) {
			const blockBytes = Math.min(Math.floor(maxBytes / 2), Math.floor(maxBytes / keys.length) - separator.length);
			const text = keys.map((key) => {
				const snap = pendingCompletionSnapshots.get(key)!;
				return formatChildCompletion(job, snap.index, snap.result, blockBytes);
			}).join(separator);
			const nextText = current ? `${current.text}${separator}${text}` : text;
			if (current && (Buffer.byteLength(nextText) > maxBytes || current.ownerSessionId !== job.ownerSessionId || current.ownerSessionFile !== job.ownerSessionFile)) {
				batches.push(current);
				current = null;
			}
			if (!current) {
				current = { ownerSessionId: job.ownerSessionId, ownerSessionFile: job.ownerSessionFile, jobs: [job], keys: [...keys], text };
			} else {
				current.jobs.push(job);
				current.keys.push(...keys);
				current.text = nextText;
			}
		}
		if (current) batches.push(current);

		let retry = false;
		for (const batch of batches) {
			const sent = sendCoordinatorMessage(batch.ownerSessionId, batch.ownerSessionFile, COMPLETION_MESSAGE, batch.text, !final, { completionKeys: batch.keys });
			if (!sent) {
				for (const key of batch.keys) {
					const snap = pendingCompletionSnapshots.get(key);
					if (!snap) continue;
					const job = jobs.get(snap.jobId);
					if (!job) continue;
					recordDeliveryFailure(job, `completion delivery failed for child ${snap.index}`);
					if (isCurrentOwner(job) && !shuttingDown) {
						pendingCompletions.add(key);
						retry = true;
					}
				}
				continue;
			}
			for (const key of batch.keys) sentCompletions.add(key);
			// Readiness clears only after a send, so a failed straggler flush stays ready for the retry.
			for (const job of batch.jobs) {
				if (job.results.every(isTerminalResult)) clearGroupStraggler(job.id);
				else stragglerDueJobs.delete(job.id);
			}
		}

		if (retry && !completionTimer) completionTimer = setTimeout(() => flushCompletions(), 500);
	}

	/** A completion counts as delivered once the parent session holds its message, not when it is queued. */
	function acknowledgeCompletions(ctx: ExtensionContext): void {
		if (sentCompletions.size === 0) return;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== COMPLETION_MESSAGE) continue;
			const keys = (entry.details as { completionKeys?: unknown } | undefined)?.completionKeys;
			if (!Array.isArray(keys)) continue;
			for (const key of keys) {
				if (typeof key !== "string" || !sentCompletions.delete(key)) continue;
				deliveredCompletions.add(key);
				pendingCompletionSnapshots.delete(key);
			}
		}
	}

	function queueCompletion(job: BackgroundJob, index: number, result: SingleResult): void {
		if (shuttingDown || !isCurrentOwner(job) || !isTerminalResult(result)) return;
		const key = completionKey(job.id, index);
		if (deliveredCompletions.has(key) || sentCompletions.has(key)) return;
		pendingCompletionSnapshots.set(key, {
			jobId: job.id,
			index,
			result: cloneResultSnapshot(result),
		});
		pendingCompletions.add(key);
		if (job.mode === "parallel" && job.total > 1 && !groupStragglerTimers.has(job.id)) {
			groupStragglerTimers.set(job.id, setTimeout(() => {
				groupStragglerTimers.delete(job.id);
				stragglerDueJobs.add(job.id);
				if (!completionTimer) completionTimer = setTimeout(() => flushCompletions(), 0);
			}, GROUP_STRAGGLER_MS));
		}
		if (!completionTimer) completionTimer = setTimeout(() => flushCompletions(), 250);
	}

	function childActivityAt(job: BackgroundJob, index: number): number {
		return Math.max(job.lastUpdateAt.get(index) ?? job.createdAt, job.results[index].inspection?.lastActivityAt ?? 0);
	}

	/** Wakes the parent once per quiet spell; routine progress stays in the status panel. */
	function reportStalls(): void {
		const now = Date.now();
		for (const job of activeJobs()) {
			if (job.state !== "running") continue;
			const notices: Array<{ index: number; activityAt: number; line: string }> = [];
			for (let index = 0; index < job.results.length; index++) {
				const result = job.results[index];
				if (result.state !== "running") continue;
				const activityAt = childActivityAt(job, index);
				const quietMs = now - activityAt;
				if (quietMs < STALL_NOTICE_MS || job.stallNoticeFor.get(index) === activityAt) continue;
				notices.push({ index, activityAt, line: `child ${index}: ${formatChildIdentity(result)} has had no activity for ${formatDuration(quietMs)}` });
			}
			if (notices.length === 0) continue;
			const text = boundCoordinatorOutput([
				`${job.id} · ${job.mode} · possible stall`,
				...notices.map((notice) => notice.line),
				"Quiet does not always mean stuck. Inspect with subagent action=status view=detail before steering or stopping.",
			].join("\n"));
			if (!sendCoordinatorMessage(job.ownerSessionId, job.ownerSessionFile, "subagent-stall", text)) continue;
			for (const notice of notices) job.stallNoticeFor.set(notice.index, notice.activityAt);
		}
	}

	function ensureStallMonitor(): void {
		if (!stallTimer) stallTimer = setInterval(reportStalls, STALL_CHECK_MS);
	}

	function stopStallMonitorIfIdle(): void {
		if (activeJobs().length > 0 || !stallTimer) return;
		clearInterval(stallTimer);
		stallTimer = null;
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

	function clearCompletionTracking(jobId: string): void {
		clearGroupStraggler(jobId);
		for (const key of [...pendingCompletions]) {
			if (key.startsWith(`${jobId}:`)) pendingCompletions.delete(key);
		}
		for (const key of [...pendingCompletionSnapshots.keys()]) {
			if (key.startsWith(`${jobId}:`)) pendingCompletionSnapshots.delete(key);
		}
		for (const key of [...sentCompletions]) {
			if (key.startsWith(`${jobId}:`)) sentCompletions.delete(key);
		}
		for (const key of [...deliveredCompletions]) {
			if (key.startsWith(`${jobId}:`)) deliveredCompletions.delete(key);
		}
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
			const removed = terminal.shift()!;
			jobs.delete(removed.id);
			clearCompletionTracking(removed.id);
		}
	}

	async function executeDispatch(
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdate | undefined,
		onStateChange: ((index: number, result: SingleResult) => void) | undefined,
		onControlReady: ((index: number, control: AgentControl) => void) | undefined,
		onControlClosed: ((index: number) => void) | undefined,
		canApplyAsync: (() => boolean) | undefined,
		ctx: ExtensionContext,
		agents: AgentConfig[],
	) {
			const makeDetails = (mode: SubagentDetails["mode"]) => (results: SingleResult[]): SubagentDetails => ({ mode, results });
			const launchPolicy = modelPolicyFrom(params);

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

					// Bound previous output for downstream steps; keep the end, where conclusions usually are.
					const MAX_PREVIOUS_CHARS = 4000;
					let previousForTask = previousOutput;
					if (previousOutput.length > MAX_PREVIOUS_CHARS) {
						let start = previousOutput.length - MAX_PREVIOUS_CHARS;
						const code = previousOutput.charCodeAt(start);
						// Starting on a low surrogate would leave half of a character.
						if (code >= 0xdc00 && code <= 0xdfff) start++;
						const kept = previousOutput.slice(start);
						previousForTask = `[Earlier output truncated: kept last ${kept.length} of ${previousOutput.length} characters]\n\n${kept}`;
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
						canApplyAsync,
						makeDetails: makeDetails("chain"),
						launchPolicy,
						itemPolicy: modelPolicyFrom(step),
						defaultMaxTurns: limits.defaultMaxTurns,
						parentCtx: ctx,
					});
					results[i] = r;

					if (isFailedResult(r)) {
						for (let pendingIndex = i + 1; pendingIndex < results.length; pendingIndex++) {
							results[pendingIndex] = {
								...results[pendingIndex],
								state: "aborted",
								exitCode: 1,
								stopReason: "skipped",
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
				if (params.tasks.length > limits.maxTasksPerLaunch) {
					return {
						content: [{ type: "text", text: `Max ${limits.maxTasksPerLaunch} tasks` }],
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
						canApplyAsync,
						makeDetails: makeDetails("parallel"),
						launchPolicy,
						itemPolicy: modelPolicyFrom(task),
						defaultMaxTurns: limits.defaultMaxTurns,
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
					canApplyAsync,
					makeDetails: makeDetails("single"),
					launchPolicy,
					defaultMaxTurns: limits.defaultMaxTurns,
					resume: params.resume,
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

	async function controlJob(params: { action: string; id?: string; message?: string; delivery?: "steer" | "followUp"; index?: number }): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined; isError?: boolean }> {
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
			if (params.index !== undefined && (!Number.isInteger(params.index) || params.index < 0 || params.index >= job.total)) {
				return { content: [{ type: "text", text: `Child index ${params.index} is outside this ${job.total}-child job.` }], details: undefined, isError: true };
			}
			const untargetedChainIndex = job.mode === "chain" && params.index === undefined
				? [...job.controls.keys()][0] ?? job.results.findIndex((result) => result.state === "queued")
				: undefined;
			const targetIndex = params.index ?? (untargetedChainIndex !== undefined && untargetedChainIndex >= 0 ? untargetedChainIndex : undefined);
			if (targetIndex !== undefined && isTerminalResult(job.results[targetIndex])) {
				return {
					content: [{ type: "text", text: `Child ${targetIndex} is already ${job.results[targetIndex].state} and cannot accept input. Message: “${messagePreview}”` }],
					details: undefined,
					isError: true,
				};
			}
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
				return { content: [{ type: "text", text: `Queued ${params.delivery ?? "steer"} for child ${queuedIndices.join(", ")}; not yet delivered. Message: “${messagePreview}”` }], details: undefined };
			}
			const deliveryResults = await Promise.all(
				targets.map(async ([index, control]) => ({
					index,
					accepted: await control.send(message, params.delivery ?? "steer").catch((error) => {
						recordDeliveryFailure(job, `child ${index}: ${error instanceof Error ? error.message : String(error)}`);
						return false;
					}),
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
					? `Accepted ${params.delivery ?? "steer"} by child ${delivered.map((item) => item.index).join(", ")}${delivered.length < targets.length ? "; other children rejected input" : ""}. Message: “${messagePreview}”`
					: `No active child in ${job.id} accepted the input. Message: “${messagePreview}”` }],
				details: undefined,
				isError: delivered.length !== targets.length,
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

		throw new Error("Unknown control action");
	}

	/** Continues an interrupted child's saved session as a new single-child job. */
	function resumeChild(params: { id?: string; index?: number; message?: string }, ctx: ExtensionContext) {
		if (!params.id || params.index === undefined) throw new Error("Resuming requires the interrupted child's job id and zero-based index");
		const recordedJobs = [...new Set([...childRecords.values()].map((record) => record.jobId))];
		const prefixed = recordedJobs.filter((jobId) => jobId.startsWith(params.id!));
		const jobId = recordedJobs.includes(params.id) ? params.id : prefixed.length === 1 ? prefixed[0] : undefined;
		if (!jobId) throw new Error(`No unique recorded subagent job in this session matches "${params.id}"`);
		const record = childRecords.get(completionKey(jobId, params.index));
		if (!record) throw new Error(`Job ${jobId} has no child ${params.index}`);
		if (record.state === "resumed") throw new Error(`Child ${params.index} of ${jobId} was already resumed (${record.stopReason})`);
		if (record.state !== undefined) throw new Error(`Child ${params.index} of ${jobId} already finished as ${record.state} and cannot be resumed`);
		if (!interruptedChildren().includes(record)) throw new Error(`Child ${params.index} of ${jobId} is still running; use action=send to give it input`);
		if (!record.sessionFile || !fs.existsSync(record.sessionFile)) {
			throw new Error(`Child ${params.index} of ${jobId} has no saved session${record.sessionFile ? ` at ${record.sessionFile}` : ""}; it stopped before its first reply. Launch the task again.`);
		}
		const { agents } = discoverAgents(ctx.cwd, "both", isParentProjectTrusted(ctx));
		const agent = agents.find((candidate) => candidate.name === record.agent);
		if (!agent) throw new Error(`Agent "${record.agent}" no longer exists, so child ${params.index} of ${jobId} cannot be resumed. Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`);
		const gondolinProvider = getGondolinToolProvider();
		const cwd = resolveAuthoritativeCwd(gondolinProvider, ctx.cwd, record.cwd);
		const trustError = projectAgentTrustError(agent, isChildProjectTrusted(ctx, gondolinProvider, cwd), cwd);
		if (trustError) throw new Error(trustError);
		if (activeJobs().length >= limits.maxActiveJobs) throw new Error(`Max ${limits.maxActiveJobs} active background jobs`);

		const message = params.message?.trim() || DEFAULT_RESUME_MESSAGE;
		const launch: ChildLaunch = { agent: record.agent, task: record.task, cwd, policy: record.policy, sessionFile: record.sessionFile };
		const job = startJob(ctx, { agent: launch.agent, task: launch.task, cwd, ...launch.policy, resume: { sessionFile: record.sessionFile, message } }, agents, [launch]);
		appendChildRecord(job, { kind: "end", jobId, index: params.index, state: "resumed", stopReason: `resumed as ${job.id}` });
		refreshWidget();
		return {
			content: [{ type: "text" as const, text: `Resumed ${jobId} child ${params.index} as job ${job.id}\n${compactHeaderLine(job.results[0], 200)}` }],
			details: { mode: job.mode, results: [...job.results], jobId: job.id, state: "running" } satisfies SubagentDetails,
		};
	}

	/** Creates and dispatches a background job; `launches` describes each child for the parent session record. */
	function startJob(ctx: ExtensionContext, params: any, agents: AgentConfig[], launches: ChildLaunch[]): BackgroundJob {
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
			cwd: getGondolinToolProvider()?.hostCwd ?? ctx.cwd,
			results: shape.results,
			controls: new Map(),
			pendingInputs: [],
			lastUpdateAt: new Map(),
			stallNoticeFor: new Map(),
			deliveryFailures: [],
			deliveryPromises: new Set(),
			abortController: new AbortController(),
			execution: Promise.resolve(),
		};
		jobs.set(job.id, job);
		for (const [index, launch] of launches.entries()) {
			appendChildRecord(job, {
				kind: "launch",
				parentSessionId: job.ownerSessionId,
				jobId: job.id,
				index,
				agent: launch.agent,
				task: truncateUtf8(launch.task, MAX_RECORD_TASK_BYTES),
				cwd: launch.cwd,
				policy: launch.policy,
				sessionFile: launch.sessionFile,
			});
		}
		ensureStallMonitor();
		refreshWidget();

		const dispatch = executeDispatch(
			params,
			job.abortController.signal,
			undefined,
			(index, result) => {
				job.results[index] = result;
				job.lastUpdateAt.set(index, Date.now());
				syncChildRecord(job, index, result);
				if (isTerminalResult(result)) queueCompletion(job, index, result);
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
			() => isCurrentOwner(job) && !shuttingDown,
			ctx,
			agents,
		);
		job.execution = dispatch.then(async (result) => {
			if (result.details?.results) {
				job.results = result.details.results;
				for (let index = 0; index < job.results.length; index++) {
					syncChildRecord(job, index, job.results[index]);
					queueCompletion(job, index, job.results[index]);
				}
			}
			await Promise.allSettled([...job.deliveryPromises]);
			for (const input of job.pendingInputs) {
				recordDeliveryFailure(job, `child ${input.index} finished before queued ${input.delivery} input was delivered`);
			}
			job.pendingInputs = [];
			job.state = job.abortController.signal.aborted
				? "stopped"
				: result.isError || job.results.some(isFailedResult) ? "failed" : "completed";
		}).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			job.error = message;
			for (let index = 0; index < job.results.length; index++) {
				if (isTerminalResult(job.results[index])) continue;
				job.results[index] = {
					...job.results[index],
					state: job.abortController.signal.aborted ? "aborted" : "failed",
					exitCode: 1,
					stopReason: job.abortController.signal.aborted ? "aborted" : "error",
					errorMessage: job.abortController.signal.aborted ? "Subagent stopped before launch" : message,
				};
				syncChildRecord(job, index, job.results[index]);
				queueCompletion(job, index, job.results[index]);
			}
			job.state = job.abortController.signal.aborted ? "stopped" : "failed";
		}).finally(() => {
			job.endedAt = Date.now();
			job.updatedAt = job.endedAt;
			if (isCurrentOwner(job)) refreshWidget();
			stopStallMonitorIfIdle();
			pruneJobs();
		});

		return job;
	}

	// ─── Subagent tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Agents",
		description: [
			"Launch specialized agents in the background so the main session remains responsive.",
			"Launch modes: single (agent + task), parallel (tasks[]), chain (steps with {previous}).",
			"Model, thinking, provider, and family can be shared launch defaults or per-task/per-step overrides.",
			"Actions: launch (default), status, send (steer/follow-up input to running children), stop (whole job), resume (continue one interrupted child from its saved session).",
			"Children left unfinished when the parent session ended show as interrupted in status and never restart on their own; resume one only when the user wants that work continued.",
			"For task, live tools/arguments/results and recent assistant text, use status view=detail with id and zero-based index. Pages are at most 16KiB; use returned offset for more. Native session paths contain full transcripts outside the workspace.",
			"After launch, return control to the user. Inspect active jobs on later turns and before accepting their work.",
			"Available agent names and descriptions are listed under the Subagents section of the system prompt; select an agent by its exact discovered name only.",
			"Children do not inherit the parent conversation, project/global instructions, skills, or extension tools — make each task self-contained: scoped goal and acceptance criteria, pointers to instructions/files the child must read, writable paths with single-writer ownership, only user-granted permissions, and how to verify or report a blocked outcome.",
			"Parallel read-only exploration is fine, but only one writer may operate in a shared worktree at a time; non-overlapping files does not waive this — use separate worktrees only when explicitly authorized.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (shuttingDown || ctx.sessionManager.getSessionId() !== currentSessionId || ctx.sessionManager.getSessionFile() !== currentSessionFile) {
				throw new Error("Subagent context no longer owns the current session");
			}
			currentCtx = ctx;

			if (params.action === "status") {
				if (params.view === "detail") {
					const job = resolveJob(params.id);
					if (!job) throw new Error("Detail requires a current-session job id or unique prefix");
					if (!Number.isInteger(params.index) || params.index! < 0 || params.index! >= job.results.length) throw new Error("Detail requires a valid zero-based child index");
					return { content: [{ type: "text", text: detailPage(`job ${job.id} · child ${params.index}\n${childDetail(job.results[params.index!])}`, params.offset) }], details: undefined };
				}
				if (params.id) {
					const job = resolveJob(params.id);
					if (!job) {
						const interrupted = interruptedChildren().filter((record) => record.jobId === params.id);
						if (interrupted.length > 0) {
							return { content: [{ type: "text", text: boundStatusOutput(interrupted.map(interruptedDetail).join("\n\n")) }], details: undefined };
						}
						return { content: [{ type: "text", text: `No unique subagent job matches "${params.id}".` }], details: undefined, isError: true };
					}
					return {
						content: [{ type: "text", text: boundStatusOutput(`job ${job.id}\n${formatJob(job, true)}`) }],
						details: { mode: job.mode, results: [...job.results], jobId: job.id, state: job.state } satisfies SubagentDetails,
					};
				}

				const ordered = [...jobs.values()]
					.filter(isCurrentOwner)
					.sort((left, right) => right.createdAt - left.createdAt);
				const visible = [
					...ordered.filter((job) => job.state === "running" || job.state === "stopping"),
					...ordered.filter((job) => job.state !== "running" && job.state !== "stopping").slice(0, 10),
				];
				const combined = visible.flatMap((job) => job.results);
				const interrupted = interruptedChildren();
				const sections = [
					...(visible.length > 0 ? [visible.map((job) => `job ${job.id}`).join("\n") + `\n${formatAgentList(combined).join("\n")}`] : []),
					...(interrupted.length > 0 ? [`interrupted (not running; resume with action=resume, id, and index):\n${interrupted.map(formatInterrupted).join("\n")}`] : []),
				];
				return {
					content: [{ type: "text", text: sections.length > 0
						? boundStatusOutput(sections.join("\n\n"))
						: "No subagent jobs have run in this session." }],
					details: visible.length > 0 ? { mode: combined.length > 1 ? "parallel" : "single", results: combined } satisfies SubagentDetails : undefined,
				};
			}

			if (params.action === "send" || params.action === "stop") {
				const response = await controlJob({ ...params, action: params.action });
				if (response.isError) throw new Error(response.content[0].text);
				return response;
			}

			if (params.action === "resume") return resumeChild(params, ctx);

			const { agents } = discoverAgents(ctx.cwd, "both", isParentProjectTrusted(ctx));
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
			if (hasTasks && params.tasks!.length > limits.maxTasksPerLaunch) {
				return { content: [{ type: "text", text: `Max ${limits.maxTasksPerLaunch} parallel tasks` }], details: undefined, isError: true };
			}
			if (activeJobs().length >= limits.maxActiveJobs) {
				return { content: [{ type: "text", text: `Max ${limits.maxActiveJobs} active background jobs` }], details: undefined, isError: true };
			}
			const gondolinProvider = getGondolinToolProvider();
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
			const launches: Array<{ agent: string; task: string; cwd?: string }> = hasChain ? params.chain! : hasTasks ? params.tasks! : [{ agent: params.agent!, task: params.task!, cwd: params.cwd }];
			const launchPolicy = modelPolicyFrom(params);
			const childLaunches: ChildLaunch[] = [];
			for (const launch of launches) {
				const agent = agents.find((candidate) => candidate.name === launch.agent)!;
				const cwd = resolveAuthoritativeCwd(gondolinProvider, ctx.cwd, launch.cwd);
				const trustError = projectAgentTrustError(agent, isChildProjectTrusted(ctx, gondolinProvider, cwd), cwd);
				if (trustError) return { content: [{ type: "text", text: trustError }], details: undefined, isError: true };
				childLaunches.push({ agent: launch.agent, task: launch.task, cwd, policy: overridePolicy(launchPolicy, modelPolicyFrom(launch)) });
			}

			const job = startJob(ctx, params, agents, childLaunches);
			const compact = job.results.map((result) => compactHeaderLine(result, 200)).join("\n");
			const warning = pendingLimitWarning ? `\n${pendingLimitWarning}` : "";
			pendingLimitWarning = undefined;
			return {
				content: [{ type: "text", text: `job ${job.id}\n${compact}${warning}` }],
				details: { mode: job.mode, results: [...job.results], jobId: job.id, state: "running" } satisfies SubagentDetails,
			};
		},
		renderShell: "self",

		// ── Render: tool call header ──
		renderCall(args, theme) {
			let text: string;
			if (args.action) {
				text = `${theme.fg("toolTitle", theme.bold("agents "))}${theme.fg("accent", args.action)}`;
			} else if (args.chain?.length) {
				const agents = args.chain.map((s: any) => s.agent);
				const flow = agents.map((a: string) => theme.fg("accent", a)).join(theme.fg("muted", " → "));
				text = `${theme.fg("toolTitle", theme.bold("agents "))}${flow}`;
			} else if (args.tasks?.length) {
				const agents = args.tasks.map((t: any) => t.agent);
				const list = agents.map((a: string) => theme.fg("accent", a)).join(theme.fg("muted", " | "));
				text = `${theme.fg("toolTitle", theme.bold("agents "))}${list}`;
			} else {
				text = `${theme.fg("toolTitle", theme.bold("agent "))}${theme.fg("accent", args.agent || "?")}`;
			}
			const box = new Box(1, 0, (value) => theme.bg("toolPendingBg", value));
			box.addChild(new Spacer(1));
			box.addChild(new Text(text, 0, 0));
			return box;
		},

		// ── Render: tool result ──
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as SubagentDetails | undefined;
			const args = (context?.args ?? {}) as { action?: string; view?: "summary" | "detail" };
			const isStatus = args.action === "status";
			const statusText = firstTextContent(result.content);
			let body: Container | Text;
			if (isStatus) {
				body = expanded
					? new Text(statusText || "(no output)", 0, 0)
					: new Text(renderCollapsedStatus(statusText, details, args.view, theme), 0, 0);
			} else if (!details || details.results.length === 0) {
				body = new Text(statusText || "(no output)", 0, 0);
			} else if (details.mode === "single" && details.results.length === 1) {
				body = expanded
					? renderExpandedResult(details.results[0], theme)
					: new Text(renderCollapsedResult(details.results[0], theme), 0, 0);
			} else if (expanded) {
				const c = new Container();
				let first = true;
				for (const child of details.results) {
					if (!first) c.addChild(new Spacer(1));
					first = false;
					c.addChild(renderExpandedResult(child, theme));
				}
				body = c;
			} else {
				body = new Text(details.results.map((child) => renderCollapsedResult(child, theme)).join("\n"), 0, 0);
			}
			const hasError = Boolean(context?.isError || details?.results.some(isFailedResult));
			const box = new Box(1, 0, (value) => theme.bg(hasError ? "toolErrorBg" : "toolPendingBg", value));
			box.addChild(body);
			box.addChild(new Spacer(1));
			return box;
		},
	});

	// ─── Background job lifecycle ─────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		inspectorController?.abort();
		if (stallTimer) clearInterval(stallTimer);
		if (completionTimer) clearTimeout(completionTimer);
		stallTimer = null;
		completionTimer = null;
		clearGroupStragglers();
		pendingCompletions.clear();
		pendingCompletionSnapshots.clear();
		sentCompletions.clear();
		for (const job of activeJobs()) {
			job.parentInterrupted = true;
			markJobStopping(job, "Parent session replaced");
		}
		shuttingDown = false;
		currentCtx = ctx;
		currentSessionId = ctx.sessionManager.getSessionId();
		currentSessionFile = ctx.sessionManager.getSessionFile();
		restoreChildRecords(ctx);
		const sessionDir = currentSessionFile ? path.dirname(currentSessionFile) : path.join(os.tmpdir(), `pi-session-${process.pid}`);
		try { fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 }); } catch {}
		jobsFile = path.join(sessionDir, `${process.pid}-subagents.json`);
		const loaded = loadSubagentLimits(ctx.cwd, isParentProjectTrusted(ctx));
		limits = loaded.limits;
		childLimiter.setLimit(limits.maxConcurrent);
		pendingLimitWarning = loaded.warnings.length > 0 ? `Subagent settings: ${loaded.warnings.join("; ")}` : undefined;
		if (pendingLimitWarning && ctx.hasUI) {
			ctx.ui.notify(pendingLimitWarning, "warning");
			pendingLimitWarning = undefined;
		}
		refreshWidget();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		currentCtx = ctx;
		const { agents } = discoverAgents(ctx.cwd, "both", isParentProjectTrusted(ctx));
		const systemPrompt = `${event.systemPrompt}\n\n${formatAgentCatalogForPrompt(agents)}`;
		const active = activeJobs();
		if (active.length === 0) return { systemPrompt };
		return {
			systemPrompt,
			message: {
				customType: "subagent-status-reminder",
				content: `${active.length} background subagent job${active.length === 1 ? " is" : "s are"} active. Self-contained child completions are delivered automatically; inspect details directly, and use subagent action=status only when the user asks for status, details are missing, or control actions are needed.`,
				display: false,
			},
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ownsContext(ctx)) acknowledgeCompletions(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// A cleared or abandoned queue drops sent completions; append what the session never received.
		if (ownsContext(ctx)) {
			acknowledgeCompletions(ctx);
			for (const key of sentCompletions) pendingCompletions.add(key);
			sentCompletions.clear();
		}
		flushCompletions(true);
		shuttingDown = true;
		inspectorController?.abort();
		if (stallTimer) clearInterval(stallTimer);
		if (completionTimer) clearTimeout(completionTimer);
		stallTimer = null;
		completionTimer = null;
		clearGroupStragglers();
		pendingCompletions.clear();
		pendingCompletionSnapshots.clear();
		deliveredCompletions.clear();
		const ownerSessionId = ctx.sessionManager.getSessionId();
		const ownerSessionFile = ctx.sessionManager.getSessionFile();
		const ownedJobs = [...jobs.values()].filter((job) =>
			job.ownerSessionId === ownerSessionId && job.ownerSessionFile === ownerSessionFile,
		);
		for (const job of ownedJobs) {
			job.parentInterrupted = true;
			markJobStopping(job, "Parent session shut down");
		}
		let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			Promise.allSettled(ownedJobs.map((job) => job.execution)).then(() => false),
			new Promise<boolean>((resolve) => {
				shutdownTimer = setTimeout(() => resolve(true), SHUTDOWN_WAIT_MS);
			}),
		]);
		clearTimeout(shutdownTimer);
		for (const job of ownedJobs) {
			for (let index = 0; index < job.results.length; index++) {
				if (isTerminalResult(job.results[index])) continue;
				job.results[index] = {
					...job.results[index],
					state: "aborted",
					exitCode: 1,
					stopReason: "aborted",
					errorMessage: timedOut ? "Parent session cleanup timed out" : "Parent session shut down",
				};
			}
			job.state = "stopped";
			job.endedAt ??= Date.now();
			jobs.delete(job.id);
			clearCompletionTracking(job.id);
		}
		try { if (jobsFile) fs.unlinkSync(jobsFile); } catch {}
		jobsFile = "";
		if (ctx.hasUI) {
			ctx.ui.setWidget("subagents", undefined);
			ctx.ui.setStatus("subagents", undefined);
		}
		childRecords.clear();
		currentCtx = null;
		currentSessionId = "";
		currentSessionFile = undefined;
	});

	function ownsContext(ctx: ExtensionContext): boolean {
		return !shuttingDown && ctx.sessionManager.getSessionId() === currentSessionId && ctx.sessionManager.getSessionFile() === currentSessionFile;
	}

	async function inspectAgents(args: string, ctx: ExtensionContext): Promise<void> {
		if (!ownsContext(ctx)) return;
		if (inspectorController) { ctx.ui.notify("Agent inspector is already open", "info"); return; }
		const controller = new AbortController();
		inspectorController = controller;
		const ownerId = currentSessionId;
		const ownerFile = currentSessionFile;
		const stillOwned = () => !controller.signal.aborted && ownsContext(ctx) && ownerId === currentSessionId && ownerFile === currentSessionFile;
		try {
			if (args.trim() === "saved") {
				const paths = await savedChildSessions(ctx.cwd, ownerId, ownerFile);
				if (stillOwned()) await showInspector(ctx, () => [{ id: "saved", index: 0, label: "Saved native session paths (read-only)", detail: () => paths, readOnly: true }], controller.signal);
				return;
			}
			const direct = args.trim();
			let action: { action: "steer" | "followUp" | "stop"; id: string; index?: number; message?: string } | undefined;
			if (direct) {
				const stop = direct.match(/^stop\s+(\S+)$/);
				const send = direct.match(/^(steer|follow-up)\s+(\S+)\s+(\d+)\s+([\s\S]+)$/);
				if (stop) action = { action: "stop", id: stop[1] };
				else if (send) action = { action: send[1] === "steer" ? "steer" : "followUp", id: send[2], index: Number(send[3]), message: send[4] };
				else throw new Error("Usage: /agents | /agents saved | /agents steer|follow-up <job> <zero-based index> <message> | /agents stop <job>");
			} else {
				action = await showInspector(ctx, () => [
					...[...jobs.values()].filter(isCurrentOwner).flatMap((job) => job.results.map((result, index) => ({
						id: job.id, index,
						label: `${job.id} [${index}] ${compactHeaderLine(result, 180)}`,
						detail: () => `job ${job.id} · child ${index} · job ${job.state}\n${childDetail(result)}`,
					}))),
					...interruptedChildren().map((record) => ({
						id: `${record.jobId} (interrupted)`, index: record.index,
						label: formatInterrupted(record),
						detail: () => interruptedDetail(record),
						readOnly: true,
					})),
				], controller.signal);
			}
			if (!action || !stillOwned()) return;
			const job = resolveJob(action.id);
			if (!job || job.state !== "running") throw new Error("Control requires a current-session running job");
			if (action.action === "stop") {
				if (!await ctx.ui.confirm("Stop subagent job?", `Stop all children in ${job.id}?`, { signal: controller.signal })) return;
			} else if (!action.message) {
				action.message = await ctx.ui.input(`Child ${action.index}: ${action.action}`, "Message to child", { signal: controller.signal });
				if (action.message === undefined) return;
			}
			if (!stillOwned()) return;
			const response = await controlJob({ action: action.action === "stop" ? "stop" : "send", id: job.id, index: action.index, delivery: action.action === "followUp" ? "followUp" : "steer", message: action.message });
			if (stillOwned()) ctx.ui.notify(terminalText(response.content[0].text), response.isError ? "error" : "info");
		} catch (error) {
			if (stillOwned()) ctx.ui.notify(terminalText(error instanceof Error ? error.message : String(error)), "error");
		} finally {
			controller.abort();
			if (inspectorController === controller) inspectorController = undefined;
		}
	}

	pi.registerCommand("agents", {
		description: "Inspect children (Ctrl+Shift+A); /agents saved, steer|follow-up <job> <index> <message>, stop <job>",
		handler: inspectAgents,
	});
	pi.registerShortcut("ctrl+shift+a", {
		description: "Inspect subagents while the main model is running",
		handler: (ctx) => inspectAgents("", ctx),
	});
}
