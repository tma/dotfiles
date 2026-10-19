/**
 * One-shot, packet-only Claude Code CLI review transport.
 *
 * Runs `claude -p` once with no tools, no MCP servers, no customizations, and no saved
 * session, in an empty temporary directory outside the workspace. The review packet goes
 * in on stdin; only the final `result` event counts as the answer. Uses Node built-ins only.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const CLAUDE_REVIEW_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeReviewEffort = (typeof CLAUDE_REVIEW_EFFORTS)[number];

export interface ClaudeReviewRequest {
	prompt: string;
	systemPrompt: string;
	effort: ClaudeReviewEffort;
	/** The checkout the review is about; the CLI never runs in or under it. */
	workspace: string;
	signal?: AbortSignal;
	/** Streaming answer text for live inspection, and a heartbeat for other activity. Never thinking. */
	onProgress?: (progress: { type: "text"; text: string } | { type: "activity" }) => void;
}

export interface ClaudeReviewUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface ClaudeReviewResult {
	text: string;
	/** The model that wrote the answer, as served, not as requested. */
	model: string;
	usage: ClaudeReviewUsage;
	/** Non-fatal findings, such as auxiliary models in `modelUsage` or a temporary directory left behind. */
	notices: string[];
}

const DEADLINE_MS = 10 * 60_000;
const KILL_GRACE_MS = 3_000;
const CLOSE_GRACE_MS = 2_000;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const OPUS = /(?:^|[./])claude-opus(?:[-.:]|$)/i;

/** Platform basics and the CLI's own login location. Provider routing and API keys are left out on purpose. */
const PASSTHROUGH_ENV = [
	"HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TZ", "LANG", "LC_ALL", "LC_CTYPE",
	"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
	"NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
	"CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN",
];

const FIXED_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "false",
	CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

const SETTINGS = JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true });

function claudeReviewEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of PASSTHROUGH_ENV) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	return { ...env, ...FIXED_ENV };
}

function claudeReviewArgs(systemPrompt: string, effort: ClaudeReviewEffort): string[] {
	return [
		"-p",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model", "opus",
		"--effort", effort,
		"--max-turns", "1",
		"--tools", "",
		"--strict-mcp-config",
		"--permission-mode", "dontAsk",
		"--safe-mode",
		"--setting-sources", "",
		"--settings", SETTINGS,
		"--disable-slash-commands",
		"--no-chrome",
		"--no-session-persistence",
		"--system-prompt", systemPrompt,
	];
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function createRunDirectory(workspace: string): string {
	const checkout = fs.realpathSync(workspace);
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-claude-review-"));
	if (isInside(checkout, directory)) {
		fs.rmdirSync(directory);
		throw new Error(`Claude Code review needs a temporary directory outside the workspace; ${directory} is inside ${workspace}`);
	}
	return directory;
}

function shorten(text: string, max = 500): string {
	const clean = text.trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, any> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

/** Tracks the stream and decides the outcome; the first problem it records wins. */
class StreamState {
	failure?: string;
	initSeen = false;
	result?: Record<string, any>;
	readonly answerModels = new Set<string>();

	constructor(private readonly onProgress: ClaudeReviewRequest["onProgress"]) {}

	fail(message: string): void {
		this.failure ??= message;
	}

	handleLine(line: string): void {
		let event: Record<string, any> | undefined;
		try {
			event = asRecord(JSON.parse(line));
		} catch {
			this.fail(`Claude Code wrote a malformed stream line: ${shorten(line, 200)}`);
			return;
		}
		if (!event || typeof event.type !== "string") {
			this.fail(`Claude Code wrote a stream line without an event type: ${shorten(line, 200)}`);
			return;
		}
		if (this.result) {
			if (event.type === "result") this.fail("Claude Code reported more than one result");
			else if (event.type === "assistant" || event.type === "stream_event") this.fail(`Claude Code kept answering after its result (${event.type})`);
			return;
		}
		switch (event.type) {
			case "system":
				if (event.subtype === "init") this.checkInit(event);
				this.progress({ type: "activity" });
				return;
			case "stream_event":
				this.handlePartial(asRecord(event.event));
				return;
			case "assistant":
				this.handleAssistant(asRecord(event.message));
				return;
			case "result":
				this.result = event;
				return;
			default:
				this.progress({ type: "activity" });
		}
	}

	private checkInit(event: Record<string, any>): void {
		this.initSeen = true;
		if (!Array.isArray(event.tools) || event.tools.length > 0) {
			this.fail(`Claude Code started with tools enabled (${JSON.stringify(event.tools ?? null)}); refusing to run a review that can act`);
		} else if (Array.isArray(event.mcp_servers) && event.mcp_servers.length > 0) {
			this.fail("Claude Code started with MCP servers configured; refusing to run a review that can act");
		}
	}

	private handlePartial(event: Record<string, any> | undefined): void {
		const blockType = asRecord(event?.content_block)?.type;
		if (event?.type === "content_block_start" && typeof blockType === "string" && blockType.endsWith("tool_use")) {
			this.fail("Claude Code tried to use a tool in a no-tool review");
			return;
		}
		const delta = asRecord(event?.delta);
		if (event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
			this.progress({ type: "text", text: delta.text });
		} else {
			this.progress({ type: "activity" });
		}
	}

	private handleAssistant(message: Record<string, any> | undefined): void {
		if (!message) {
			this.fail("Claude Code wrote an assistant event without a message");
			return;
		}
		if (typeof message.model === "string") this.answerModels.add(message.model);
		const content = Array.isArray(message.content) ? message.content : [];
		const unexpected = content.map((part) => asRecord(part)?.type).filter((type) => type !== "text" && type !== "thinking" && type !== "redacted_thinking");
		if (unexpected.length > 0) this.fail(`Claude Code returned unexpected content in a no-tool review: ${unexpected.join(", ")}`);
		this.progress({ type: "activity" });
	}

	private progress(update: { type: "text"; text: string } | { type: "activity" }): void {
		if (!this.onProgress) return;
		try {
			this.onProgress(update);
		} catch (error) {
			this.fail(`Review progress callback failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Checks the terminal result and the served model; throws when the run didn't produce a usable review. */
	finish(): ClaudeReviewResult {
		const result = this.result;
		if (!result) throw new Error("Claude Code ended without a result");
		if (result.subtype !== "success" || result.is_error !== false) {
			const detail = typeof result.result === "string" && result.result.trim()
				? result.result
				: Array.isArray(result.errors) ? result.errors.map(String).join("; ") : "";
			throw new Error(`Claude Code reported an error (${String(result.subtype ?? "no subtype")}${result.is_error === true ? ", is_error" : ""})${detail ? `: ${shorten(detail)}` : ""}`);
		}
		if (result.stop_reason != null && result.stop_reason !== "end_turn") {
			throw new Error(`Claude Code review did not finish normally (stop_reason: ${String(result.stop_reason)}); partial output is not a completed review`);
		}
		if (typeof result.result !== "string" || !result.result.trim()) throw new Error("Claude Code returned an empty review");
		if (Buffer.byteLength(result.result) > MAX_RESULT_BYTES) throw new Error(`Claude Code review is larger than ${MAX_RESULT_BYTES} bytes`);
		if (!this.initSeen) throw new Error("Claude Code never reported its startup settings, so the no-tool setup is unconfirmed");

		const modelUsage = asRecord(result.modelUsage) ?? {};
		const usedModels = Object.keys(modelUsage);
		const answerModels = [...this.answerModels];
		if (answerModels.length === 0) throw new Error("Claude Code did not report which model wrote the review");
		const nonOpus = answerModels.filter((model) => !OPUS.test(model));
		if (nonOpus.length > 0) throw new Error(`Claude Code answered with ${nonOpus.join(", ")} instead of Opus`);
		const unreported = answerModels.filter((model) => !usedModels.includes(model));
		if (unreported.length > 0) throw new Error(`Claude Code result modelUsage does not include the answering model ${unreported.join(", ")}`);
		const auxiliary = usedModels.filter((model) => !OPUS.test(model));

		const usage = asRecord(result.usage) ?? {};
		const input = count(usage.input_tokens);
		const output = count(usage.output_tokens);
		const cacheRead = count(usage.cache_read_input_tokens);
		const cacheWrite = count(usage.cache_creation_input_tokens);
		return {
			text: result.result,
			model: answerModels.join(","),
			usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: count(result.total_cost_usd) },
			notices: auxiliary.length > 0 ? [`Claude Code also used ${auxiliary.join(", ")} for auxiliary requests`] : [],
		};
	}
}

/** Splits stdout into lines on newline bytes, so a character split across chunks is decoded whole. */
class LineReader {
	private parts: Buffer[] = [];
	private partBytes = 0;
	private total = 0;
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });

	constructor(private readonly onLine: (line: string) => void, private readonly onError: (message: string) => void) {}

	push(chunk: Buffer): void {
		this.total += chunk.length;
		if (this.total > MAX_STDOUT_BYTES) {
			this.onError(`Claude Code wrote more than ${MAX_STDOUT_BYTES} bytes of output`);
			return;
		}
		let start = 0;
		for (let index = chunk.indexOf(0x0a); index >= 0; index = chunk.indexOf(0x0a, start)) {
			this.parts.push(chunk.subarray(start, index));
			this.emit();
			start = index + 1;
		}
		if (start < chunk.length) {
			this.parts.push(chunk.subarray(start));
			this.partBytes += chunk.length - start;
			if (this.partBytes > MAX_LINE_BYTES) this.onError(`Claude Code wrote a stream line longer than ${MAX_LINE_BYTES} bytes`);
		}
	}

	end(): void {
		if (this.parts.length > 0) this.emit();
	}

	private emit(): void {
		const line = Buffer.concat(this.parts);
		this.parts = [];
		this.partBytes = 0;
		if (line.length > MAX_LINE_BYTES) {
			this.onError(`Claude Code wrote a stream line longer than ${MAX_LINE_BYTES} bytes`);
			return;
		}
		let text: string;
		try {
			text = this.decoder.decode(line);
		} catch {
			this.onError("Claude Code wrote invalid UTF-8");
			return;
		}
		if (text.trim()) this.onLine(text);
	}
}

/** Runs one packet-only Opus review through the local `claude` CLI. Resolves only after the process has closed. */
export async function runClaudeReview(request: ClaudeReviewRequest): Promise<ClaudeReviewResult> {
	if (!CLAUDE_REVIEW_EFFORTS.includes(request.effort)) throw new Error(`Unsupported Claude Code effort "${request.effort}"`);
	if (Buffer.byteLength(request.prompt) > MAX_INPUT_BYTES) throw new Error(`Review packet is larger than ${MAX_INPUT_BYTES} bytes; narrow the scope`);
	if (Buffer.byteLength(request.systemPrompt) > MAX_SYSTEM_PROMPT_BYTES) throw new Error(`Reviewer prompt is larger than ${MAX_SYSTEM_PROMPT_BYTES} bytes`);
	request.signal?.throwIfAborted();

	const directory = createRunDirectory(request.workspace);
	let outcome: ClaudeReviewResult | undefined;
	let failure: unknown;
	try {
		outcome = await spawnReview(request, directory);
	} catch (error) {
		failure = error;
	}
	const cleanupProblem = removeRunDirectory(directory);
	if (!outcome) {
		const message = failure instanceof Error ? failure.message : String(failure);
		throw new Error(cleanupProblem ? `${message}\n${cleanupProblem}` : message);
	}
	return cleanupProblem ? { ...outcome, notices: [...outcome.notices, cleanupProblem] } : outcome;
}

/** Removes the run directory only if it is empty; anything left there was written by something unexpected. */
function removeRunDirectory(directory: string): string | undefined {
	try {
		fs.rmdirSync(directory);
		return undefined;
	} catch (error) {
		return `Temporary directory ${directory} was not removed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function spawnReview(request: ClaudeReviewRequest, directory: string): Promise<ClaudeReviewResult> {
	return new Promise((resolve, reject) => {
		const state = new StreamState(request.onProgress);
		const useGroup = process.platform !== "win32";
		let child: ChildProcess;
		try {
			child = spawn("claude", claudeReviewArgs(request.systemPrompt, request.effort), {
				cwd: directory,
				env: claudeReviewEnv(),
				stdio: ["pipe", "pipe", "pipe"],
				detached: useGroup,
				shell: false,
				windowsHide: true,
			});
		} catch (error) {
			reject(new Error(`Cannot start Claude Code CLI: ${error instanceof Error ? error.message : String(error)}`));
			return;
		}

		let stderr = "";
		const stderrDecoder = new StringDecoder("utf8");
		let spawnError: Error | undefined;
		let stdinError: Error | undefined;
		let timedOut = false;
		let aborted = false;
		let terminating = false;
		let settled = false;
		const timers: Array<ReturnType<typeof setTimeout>> = [];

		const signalProcess = (signal: NodeJS.Signals) => {
			if (child.pid === undefined) return;
			try {
				if (useGroup) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					state.fail(`Cannot send ${signal} to Claude Code: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		};
		const terminate = () => {
			if (terminating || settled) return;
			terminating = true;
			signalProcess("SIGTERM");
			timers.push(setTimeout(() => {
				signalProcess("SIGKILL");
				// A descendant that left the group can hold the pipes open; stop waiting for it.
				timers.push(setTimeout(() => finish(null, "SIGKILL", "Claude Code did not close its output after SIGKILL"), CLOSE_GRACE_MS));
			}, KILL_GRACE_MS));
		};
		const failAndStop = (message: string) => {
			state.fail(message);
			terminate();
		};
		const onAbort = () => {
			aborted = true;
			terminate();
		};

		const lines = new LineReader((line) => {
			if (state.failure) return;
			state.handleLine(line);
			if (state.failure) terminate();
		}, failAndStop);

		function finish(code: number | null, signal: NodeJS.Signals | null, closeProblem?: string): void {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
			child.stdout?.removeAllListeners("data");
			child.stderr?.removeAllListeners("data");
			if (!closeProblem) lines.end();
			// Pipes stay open after a failed spawn or an unclosed descendant; nothing reads them now.
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			stderr = (stderr + stderrDecoder.end()).slice(-MAX_STDERR_CHARS);
			const stderrNote = stderr.trim() ? `\nstderr: ${shorten(stderr, 2000)}` : "";
			const failureNote = state.failure ? `: ${state.failure}` : "";
			if (aborted) return reject(new Error(`Claude Code review aborted${failureNote}${stderrNote}`));
			if (timedOut) return reject(new Error(`Claude Code review timed out after ${DEADLINE_MS / 60_000} minutes${failureNote}${stderrNote}`));
			if (spawnError) {
				const missing = (spawnError as NodeJS.ErrnoException).code === "ENOENT";
				return reject(new Error(missing ? "Claude Code CLI `claude` was not found on PATH" : `Cannot start Claude Code CLI: ${spawnError.message}`));
			}
			if (state.failure) return reject(new Error(`${state.failure}${stderrNote}`));
			if (closeProblem) return reject(new Error(`${closeProblem}${stderrNote}`));
			if (code !== 0) {
				const reported = typeof state.result?.result === "string" && state.result.result.trim() ? `: ${shorten(state.result.result)}` : "";
				return reject(new Error(`Claude Code exited with ${signal ? `signal ${signal}` : `code ${code}`}${reported}${stderrNote}`));
			}
			if (stdinError) return reject(new Error(`Cannot send the review packet to Claude Code: ${stdinError.message}`));
			try {
				resolve(state.finish());
			} catch (error) {
				reject(new Error(`${error instanceof Error ? error.message : String(error)}${stderrNote}`));
			}
		}

		child.on("error", (error) => {
			spawnError ??= error;
			if (child.pid === undefined) finish(null, null);
		});
		child.on("exit", () => {
			// Clean up anything the CLI left running in its process group.
			if (useGroup) signalProcess("SIGKILL");
		});
		child.on("close", (code, signal) => finish(code, signal));
		child.stdout!.on("data", (chunk: Buffer) => {
			if (!state.failure) lines.push(chunk);
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr = (stderr + stderrDecoder.write(chunk)).slice(-MAX_STDERR_CHARS);
		});
		child.stdin!.on("error", (error) => {
			stdinError ??= error;
		});

		timers.push(setTimeout(() => {
			timedOut = true;
			terminate();
		}, DEADLINE_MS));
		if (request.signal?.aborted) onAbort();
		else request.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin!.end(request.prompt);
	});
}
