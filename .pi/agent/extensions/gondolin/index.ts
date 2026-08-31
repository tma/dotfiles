/**
 * Gondolin Tool Routing Example
 *
 * Runs pi's built-in tools inside a local Gondolin micro-VM. The host working
 * directory is mounted at /workspace in the guest. File changes under
 * /workspace write through to the host; other guest filesystem changes are
 * isolated to the VM.
 *
 * Setup:
 *   cd packages/coding-agent/examples/extensions/gondolin
 *   npm install --ignore-scripts
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/gondolin
 *
 * Requirements:
 *   - Node.js >= 23.6.0 for @earendil-works/gondolin
 *   - QEMU installed (for example, `brew install qemu` on macOS)
 *
 * Custom guest image (git, gh, ripgrep, jq):
 *   npm install --ignore-scripts --prefix ~/.pi/agent/extensions/gondolin
 *   npm run build-image --prefix ~/.pi/agent/extensions/gondolin
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RealFSProvider, VM } from "@earendil-works/gondolin";
import { Agent, fetch as undiciFetch } from "undici";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const GUEST_HOME = "/root";
const DEFAULT_GREP_LIMIT = 100;
const QEMU_BINARIES = ["qemu-system-aarch64", "qemu-system-x86_64"];
const GUEST_SSH_CONFIG = "/root/.ssh/config";
const ONE_PASSWORD_AGENT = path.join(
	os.homedir(),
	"Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
);

export interface GondolinToolProvider {
	readonly hostCwd: string;
	readonly tools: readonly ToolDefinition<any>[];
}

const GONDOLIN_TOOL_PROVIDER = Symbol.for("tma.pi.gondolin.tool-provider");

function setGondolinToolProvider(provider: GondolinToolProvider | undefined): void {
	(globalThis as any)[GONDOLIN_TOOL_PROVIDER] = provider;
}

/** Returns tools bound to the parent Gondolin VM and its authoritative host workspace. */
export function getGondolinToolProvider(): GondolinToolProvider | undefined {
	return (globalThis as any)[GONDOLIN_TOOL_PROVIDER] as GondolinToolProvider | undefined;
}

/**
 * Optional SSH egress config, kept outside this repository because it names
 * private hosts. Default location: ~/.config/gondolin/ssh.json
 *
 *   {
 *     "agent": "/path/to/agent.sock",
 *     "knownHostsFile": "/path/to/known_hosts",
 *     "hosts": [{ "host": "host.example.com", "alias": "short", "user": "me" }]
 *   }
 *
 * Gondolin terminates guest SSH on the host and re-authenticates upstream with
 * the host agent, so no private key or agent socket ever enters the guest.
 * Guest hostnames must resolve on the host: the host proxy dials the same name
 * the guest looked up. Upstream host keys are checked against the host's
 * known_hosts under that same name.
 */
type SshHostEntry = {
	host: string;
	alias?: string;
	user?: string;
};

type SshEgressConfig = {
	allowedHosts: string[];
	agent: string;
	knownHostsFile?: string | string[];
	readyTimeoutMs: number;
	entries: SshHostEntry[];
};

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function socketExists(candidate: string | undefined): candidate is string {
	if (!candidate) return false;
	try {
		return statSync(candidate).isSocket();
	} catch {
		return false;
	}
}

function resolveSshAgent(configured: unknown): string | undefined {
	const candidates = [
		typeof configured === "string" ? expandHome(configured) : undefined,
		process.env.GONDOLIN_SSH_AGENT,
		ONE_PASSWORD_AGENT,
		process.env.SSH_AUTH_SOCK,
	];
	return candidates.find(socketExists);
}

function parseSshHostEntries(raw: unknown): SshHostEntry[] {
	if (!Array.isArray(raw)) return [];
	const entries: SshHostEntry[] = [];
	for (const item of raw) {
		if (typeof item === "string") {
			const host = item.trim();
			if (host) entries.push({ host });
			continue;
		}
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const host = typeof record.host === "string" ? record.host.trim() : "";
		if (!host) continue;
		entries.push({
			host,
			alias: typeof record.alias === "string" && record.alias.trim() ? record.alias.trim() : undefined,
			user: typeof record.user === "string" && record.user.trim() ? record.user.trim() : undefined,
		});
	}
	return entries;
}

function loadSshEgressConfig(): SshEgressConfig | undefined {
	const configPath =
		process.env.GONDOLIN_SSH_CONFIG ?? path.join(os.homedir(), ".config", "gondolin", "ssh.json");
	if (!existsSync(configPath)) return undefined;

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}

	const entries = parseSshHostEntries(parsed.hosts);
	if (entries.length === 0) return undefined;

	const agent = resolveSshAgent(parsed.agent);
	if (!agent) return undefined;

	const knownHostsFile =
		typeof parsed.knownHostsFile === "string"
			? expandHome(parsed.knownHostsFile)
			: Array.isArray(parsed.knownHostsFile)
				? parsed.knownHostsFile.filter((file): file is string => typeof file === "string").map(expandHome)
				: undefined;

	return {
		allowedHosts: entries.map((entry) => entry.host),
		agent,
		knownHostsFile,
		// The first connection after 1Password locks needs an approval click, and
		// gondolin's 15s default expires before most people get there.
		readyTimeoutMs:
			typeof parsed.readyTimeoutMs === "number" && parsed.readyTimeoutMs > 0 ? parsed.readyTimeoutMs : 60_000,
		entries,
	};
}

function renderGuestSshConfig(entries: SshHostEntry[]): string {
	const blocks = entries.map((entry) => {
		const hostname = entry.host.split(":")[0] ?? entry.host;
		const patterns = entry.alias && entry.alias !== hostname ? `${entry.alias} ${hostname}` : hostname;
		const lines = [`Host ${patterns}`, `    HostName ${hostname}`];
		if (entry.user) lines.push(`    User ${entry.user}`);
		// The guest talks to gondolin's per-VM proxy host key, not the real host key.
		// Upstream host keys are verified on the host against known_hosts.
		lines.push("    StrictHostKeyChecking no", "    UserKnownHostsFile /dev/null", "    LogLevel ERROR");
		return lines.join("\n");
	});
	return `# generated by the pi gondolin extension\n${blocks.join("\n\n")}\n`;
}

async function installGuestSshConfig(vm: VM, entries: SshHostEntry[]): Promise<void> {
	const content = renderGuestSshConfig(entries);
	const script = [
		`mkdir -p ${path.posix.dirname(GUEST_SSH_CONFIG)}`,
		`chmod 700 ${path.posix.dirname(GUEST_SSH_CONFIG)}`,
		`cat > ${GUEST_SSH_CONFIG} <<'GONDOLIN_SSH_CONFIG_EOF'\n${content}GONDOLIN_SSH_CONFIG_EOF`,
		`chmod 600 ${GUEST_SSH_CONFIG}`,
	].join("\n");
	await vm.exec(["/bin/sh", "-lc", script]);
}

/**
 * undici 6 (gondolin's http bridge) picks up the global dispatcher, which on
 * current Node versions is Node's own bundled undici. The two disagree on
 * request internals, so every request with a body fails with "invalid
 * content-length header" and the guest sees a 502. Handing gondolin a fetch
 * bound to a matching undici 6 agent keeps both halves on the same version.
 */
function createMatchedFetch(): typeof undiciFetch {
	const agent = new Agent();
	return ((url: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
		undiciFetch(url, { ...init, dispatcher: agent })) as typeof undiciFetch;
}

/**
 * The guest inherits the host environment, so `HOME` points at a macOS path
 * that does not exist in the VM. That breaks `git config --global` and
 * anything else writing to the home directory. `SSH_AUTH_SOCK` is dropped for
 * the same reason: it names a host socket the guest cannot reach, and SSH
 * egress is proxied on the host anyway.
 */
function guestEnvOverrides(): Record<string, string> {
	return {
		HOME: GUEST_HOME,
		USER: "root",
		LOGNAME: "root",
		SSH_AUTH_SOCK: "",
	};
}

async function configureGuestGit(vm: VM): Promise<void> {
	// The workspace is owned by the host uid, which git reads as someone else's
	// repository unless we mark it safe.
	await vm.exec([
		"/bin/sh",
		"-lc",
		`git config --global --add safe.directory ${GUEST_WORKSPACE} 2>/dev/null || true`,
	]);
}

function hasQemu(): boolean {
	for (const binary of QEMU_BINARIES) {
		try {
			execFileSync("which", [binary], { stdio: "ignore" });
			return true;
		} catch {
			// try the next candidate
		}
	}
	return false;
}

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(localCwd, filePath));
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
		},
		mkdir: async (dirPath) => {
			await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
		},
	};
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
		readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
	};
}

async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const stat = await vm.fs.stat(root, { signal });
	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const entries = await vm.fs.listDir(dir, { signal });
		for (const entry of entries) {
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(dir, entry);
			const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
			let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStat = await vm.fs.stat(guestPath, { signal });
			} catch {
				continue;
			}
			if (entryStat.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = toGuestPath(localCwd, cwd);
			const results: string[] = [];
			await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
				return results.length < options.limit;
			});
			return results;
		},
	};
}

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
	const end =
		params.contextLines > 0
			? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
			: params.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = params.lines[index] ?? "";
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

async function executeGondolinGrep(
	vm: VM,
	localCwd: string,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toGuestPath(localCwd, params.path ?? ".");
	const rootStat = await vm.fs.stat(root, { signal });
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
			let content: string;
			try {
				content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
			} catch {
				return true;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

function guestEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
	return { ...(sanitizeEnv(env) ?? {}), ...guestEnvOverrides() };
}

function createGondolinBashOps(vm: VM, localCwd: string, shellPath: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			const guestCwd = toGuestPath(localCwd, cwd);
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec([shellPath, "-lc", command], {
					cwd: guestCwd,
					env: guestEnv(env),
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				for await (const chunk of proc.output()) onData(chunk.data);
				const result = await proc;
				return { exitCode: result.exitCode };
			} catch (error) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	const inCodespace = process.env.CODESPACES === "true" || Boolean(process.env.CODESPACE_NAME);
	if (inCodespace || !hasQemu()) {
		// Codespaces is already a container. Missing QEMU on a host is a setup gap;
		// stay quiet either way so the footer/startup path stays stock.
		return;
	}

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	let vm: VM | undefined;
	let vmStarting: Promise<VM> | undefined;
	let toolProvider: GondolinToolProvider | undefined;
	let shellPath = "/bin/sh";
	const sshEgress = loadSshEgressConfig();

	async function startVm(_ctx?: ExtensionContext): Promise<VM> {
		const imageDir = fileURLToPath(new URL("./image", import.meta.url));
		const created = await VM.create({
			sessionLabel: `pi ${path.basename(localCwd)}`,
			fetch: createMatchedFetch(),
			env: guestEnvOverrides(),
			...(existsSync(path.join(imageDir, "manifest.json")) ? { sandbox: { imagePath: imageDir } } : {}),
			...(sshEgress
				? {
						ssh: {
							allowedHosts: sshEgress.allowedHosts,
							agent: sshEgress.agent,
							upstreamReadyTimeoutMs: sshEgress.readyTimeoutMs,
							...(sshEgress.knownHostsFile ? { knownHostsFile: sshEgress.knownHostsFile } : {}),
						},
					}
				: {}),
			vfs: {
				mounts: {
					[GUEST_WORKSPACE]: new RealFSProvider(localCwd),
				},
			},
		});
		const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
		shellPath = bashProbe.stdout.trim() || "/bin/sh";
		await configureGuestGit(created);
		if (sshEgress) await installGuestSshConfig(created, sshEgress.entries);
		vm = created;
		return created;
	}

	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (vm) return vm;
		if (!vmStarting) {
			vmStarting = startVm(ctx).finally(() => {
				vmStarting = undefined;
			});
		}
		return vmStarting;
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureVm(ctx);
	});

	pi.on("session_shutdown", async () => {
		const activeVm = vm;
		vm = undefined;
		vmStarting = undefined;
		if (getGondolinToolProvider() === toolProvider) setGondolinToolProvider(undefined);
		toolProvider = undefined;
		if (!activeVm) return;
		await activeVm.close();
	});

	pi.registerCommand("gondolin", {
		description: "Show Gondolin VM status",
		handler: async (_args, ctx) => {
			const activeVm = await ensureVm(ctx);
			ctx.ui.notify(
				[
					`Gondolin VM: ${activeVm.id}`,
					`Host workspace: ${localCwd}`,
					`Guest workspace: ${GUEST_WORKSPACE}`,
					`Shell: ${shellPath}`,
					sshEgress
						? `SSH egress: ${sshEgress.allowedHosts.join(", ")} (host agent ${sshEgress.agent})`
						: "SSH egress: disabled",
				].join("\n"),
				"info",
			);
		},
	});

	const gondolinTools: ToolDefinition<any>[] = [
		{
			...localRead,
			async execute(id, params: any, signal, onUpdate, ctx) {
				const activeVm = await ensureVm(ctx);
				const tool = createReadTool(GUEST_WORKSPACE, {
					operations: createGondolinReadOps(activeVm, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		},
		{
			...localWrite,
			async execute(id, params: any, signal, onUpdate, ctx) {
				const activeVm = await ensureVm(ctx);
				const tool = createWriteTool(GUEST_WORKSPACE, {
					operations: createGondolinWriteOps(activeVm, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		},
		{
			...localEdit,
			async execute(id, params: any, signal, onUpdate, ctx) {
				const activeVm = await ensureVm(ctx);
				const tool = createEditTool(GUEST_WORKSPACE, {
					operations: createGondolinEditOps(activeVm, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		},
		{
			...localBash,
			async execute(id, params: any, signal, onUpdate, ctx) {
				const activeVm = await ensureVm(ctx);
				const tool = createBashTool(GUEST_WORKSPACE, {
					operations: createGondolinBashOps(activeVm, localCwd, shellPath),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		},
		{
			...localLs,
			async execute(id, params: any, signal, onUpdate, ctx) {
				const activeVm = await ensureVm(ctx);
				const tool = createLsTool(GUEST_WORKSPACE, {
					operations: createGondolinLsOps(activeVm, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		},
		{
			...localFind,
			async execute(id, params: any, signal, onUpdate, ctx) {
				const activeVm = await ensureVm(ctx);
				const tool = createFindTool(GUEST_WORKSPACE, {
					operations: createGondolinFindOps(activeVm, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		},
		{
			...localGrep,
			async execute(_id, params: any, signal, _onUpdate, ctx) {
				const activeVm = await ensureVm(ctx);
				return executeGondolinGrep(activeVm, localCwd, params, signal);
			},
		},
	];
	toolProvider = { hostCwd: localCwd, tools: gondolinTools };
	setGondolinToolProvider(toolProvider);
	for (const tool of gondolinTools) pi.registerTool(tool);

	pi.on("user_bash", async (_event, ctx) => {
		const activeVm = await ensureVm(ctx);
		return { operations: createGondolinBashOps(activeVm, localCwd, shellPath) };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await ensureVm(ctx);
		const localLine = `Current working directory: ${localCwd}`;
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, guestLine)
			: `${event.systemPrompt}\n\n${guestLine}`;
		return { systemPrompt };
	});
}
