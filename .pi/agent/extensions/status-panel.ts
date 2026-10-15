/**
 * Pi Status Panel Extension
 *
 * Opens a right split pane in cmux, tmux, or Rex showing modified files, git
 * status, diff stats, and recent commits — like OpenCode's right sidebar.
 *
 * Toggle with /status or ctrl+shift+s. Pi's default footer is hidden while
 * the panel is open because the panel shows the same session details.
 * Requires cmux, tmux, or Rex. Child subagents can disable mux UI with
 * PI_DISABLE_MUX_UI=1 to avoid nested panels.
 */

import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PanelHandle =
	| { backend: "cmux"; ref: string }
	| { backend: "tmux"; ref: string }
	| { backend: "rex"; session: string; ref: string };

type RexPanelHandle = Extract<PanelHandle, { backend: "rex" }>;

interface RexPanelWatch {
	handle: RexPanelHandle;
	child: ChildProcess | null;
	retryTimer: ReturnType<typeof setTimeout> | null;
	retryDelayMs: number;
	failureReported: boolean;
}

// Rex CLI exit status for a target that was not found or was ambiguous. Saved
// full IDs cannot be ambiguous, so it means the block is gone.
const REX_TARGET_NOT_FOUND = 3;
const REX_WATCH_RETRY_MS = 1000;
const REX_WATCH_MAX_RETRY_MS = 30000;

function isMuxUiDisabled(): boolean {
	const value = process.env.PI_DISABLE_MUX_UI?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function isCmux(): boolean {
	if (isMuxUiDisabled()) return false;
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
	if (isMuxUiDisabled()) return false;
	return !!process.env.TMUX && !!process.env.TMUX_PANE;
}

function isRex(): boolean {
	if (isMuxUiDisabled()) return false;
	return !!process.env.REX_SESSION && !!process.env.REX_BLOCK;
}

function getMuxBackend(): PanelHandle["backend"] | null {
	// Prefer explicit current-session markers first. This lets tmux or Rex win
	// when a cmux socket happens to exist on disk but Pi is running elsewhere.
	// tmux is checked before Rex because tmux commonly runs inside Rex.
	if (process.env.CMUX_WORKSPACE_ID && !isMuxUiDisabled()) return "cmux";
	if (isTmux()) return "tmux";
	if (isRex()) return "rex";
	if (isCmux()) return "cmux";
	return null;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmuxSync(args: string[]): string | null {
	try {
		return execFileSync("cmux", args, { timeout: 3000, encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}

function tmuxSync(args: string[]): string | null {
	try {
		return execFileSync("tmux", args, { timeout: 3000, encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}

function rexSync(args: string[]): string {
	try {
		return execFileSync("rex", args, {
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(`rex ${args[0]} failed: ${stderr || (error as Error).message}`, { cause: error });
	}
}

// Reads the exit status from a child_process error, or from the error it wraps.
function rexExitStatus(error: unknown): number | null {
	if (!error || typeof error !== "object") return null;
	const { status, code, cause } = error as { status?: unknown; code?: unknown; cause?: unknown };
	if (typeof status === "number") return status;
	if (typeof code === "number") return code;
	return rexExitStatus(cause);
}

function isRexTargetMissing(error: unknown): boolean {
	return rexExitStatus(error) === REX_TARGET_NOT_FOUND;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function resolveStatusPanelScript(): string {
	const candidates = [
		path.join(os.homedir(), ".pi", "agent", "extensions", "status-panel.sh"),
		path.join(path.dirname(fileURLToPath(import.meta.url)), "status-panel.sh"),
	];

	return candidates.find(fileExists) ?? candidates[0];
}

export default function (pi: ExtensionAPI) {
	let sessionDir = "";
	let panelHandle: PanelHandle | null = null;
	let rexWatch: RexPanelWatch | null = null;
	// Context that hid the footer; it stays valid until session_shutdown.
	let footerCtx: ExtensionContext | null = null;
	const scriptPath = resolveStatusPanelScript();
	const panelStateFile = path.join(os.tmpdir(), `pi-${process.pid}-status-panel.json`);
	const tmuxStatusPaneStyle = "bg=#171a21";

	function writePanelState(handle: PanelHandle | null): void {
		try {
			if (handle) {
				writeFileSync(panelStateFile, JSON.stringify({
					open: true,
					backend: handle.backend,
					ref: handle.ref,
					updatedAt: Date.now(),
				}), "utf-8");
			} else {
				unlinkSync(panelStateFile);
			}
		} catch {
			if (!handle) {
				try {
					unlinkSync(panelStateFile);
				} catch {}
			}
		}
	}

	function openCmuxPanel(cwd: string): PanelHandle | null {
		if (!sessionDir) return null;

		// Create a right split — returns "OK surface:<id> workspace:<id>"
		const result = cmuxSync(["new-split", "right"]);
		if (!result) return null;

		const match = result.match(/surface:(\S+)/);
		const surfaceId = match ? `surface:${match[1]}` : null;
		if (!surfaceId) return null;

		// Resize pi's pane to ~3/4 width
		// After 50/50 split, grow pi's (left) pane right so it gets 3/4, panel gets 1/4
		try {
			const tree = cmuxSync(["tree"]);
			if (tree) {
				let piPaneId: string | null = null;
				let currentPaneId: string | null = null;
				for (const line of tree.split("\n")) {
					const paneMatch = line.match(/(pane:\d+)/);
					if (paneMatch) currentPaneId = paneMatch[1];
					if (line.includes("\u25c0 here")) {
						piPaneId = currentPaneId;
						break;
					}
				}
				if (piPaneId) {
					const cols = process.stdout.columns || 80;
					execFileSync("cmux", ["resize-pane", "--pane", piPaneId, "-R", "--amount", String(Math.round(cols * 3 / 4))], { timeout: 2000 });
					execFileSync("cmux", ["focus-pane", "--pane", piPaneId], { timeout: 2000 });
				}
			}
		} catch {}

		try {
			execFileSync("cmux", ["rename-tab", "--surface", surfaceId, "Status"], { timeout: 2000 });
		} catch {}

		// Send cd + script to the new surface and press enter
		setTimeout(() => {
			const cmd = `cd ${shellQuote(cwd)} && PI_PID=${process.pid} PI_SESSION_DIR=${shellQuote(sessionDir)} ${shellQuote(scriptPath)}`;
			execFile("cmux", ["send", "--surface", surfaceId, cmd], { timeout: 3000 }, () => {});
			setTimeout(() => {
				execFile("cmux", ["send-key", "--surface", surfaceId, "enter"], { timeout: 3000 }, () => {});
			}, 100);
		}, 300);

		return { backend: "cmux", ref: surfaceId };
	}

	function openTmuxPanel(cwd: string): PanelHandle | null {
		if (!sessionDir) return null;
		const targetPane = process.env.TMUX_PANE;
		if (!targetPane) return null;

		const paneId = tmuxSync([
			"split-window",
			"-d",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
			"-l",
			"35%",
			"-t",
			targetPane,
			"-c",
			cwd,
			"-e",
			`PI_PID=${process.pid}`,
			"-e",
			`PI_SESSION_DIR=${sessionDir}`,
			scriptPath,
		]);
		if (!paneId) return null;

		try {
			execFileSync("tmux", ["select-pane", "-t", paneId, "-T", "Status"], { timeout: 2000 });
			execFileSync("tmux", ["set-option", "-pt", paneId, "window-style", tmuxStatusPaneStyle], { timeout: 2000 });
		} catch {}

		return { backend: "tmux", ref: paneId };
	}

	// Throws with the Rex error so callers can surface it.
	function openRexPanel(cwd: string): PanelHandle | null {
		const session = process.env.REX_SESSION;
		const anchorBlock = process.env.REX_BLOCK;
		if (!sessionDir || !session || !anchorBlock) return null;

		const output = rexSync([
			"split",
			"-s",
			session,
			"-b",
			anchorBlock,
			"--split",
			"right",
			"--ratio",
			"35",
			"--focus=false",
			"--cwd",
			cwd,
			"--label",
			"Status",
			"--json",
			"--",
			"env",
			`PI_PID=${process.pid}`,
			`PI_SESSION_DIR=${sessionDir}`,
			scriptPath,
		]);

		let blockId: unknown;
		try {
			blockId = JSON.parse(output)?.block_ids?.[0];
		} catch {}
		if (typeof blockId !== "string" || !/^block:\S+$/.test(blockId)) {
			throw new Error(`rex split returned no block ID: ${output}`);
		}

		return { backend: "rex", session, ref: blockId };
	}

	function openPanel(cwd: string): boolean {
		const backend = getMuxBackend();
		if (!backend) return false;
		if (!sessionDir) return false;
		if (!fileExists(scriptPath)) return false;

		if (backend === "cmux") {
			panelHandle = openCmuxPanel(cwd);
		} else if (backend === "tmux") {
			panelHandle = openTmuxPanel(cwd);
		} else {
			panelHandle = openRexPanel(cwd);
		}
		writePanelState(panelHandle);
		if (panelHandle?.backend === "rex") {
			watchRexPanel(panelHandle);
		}
		return !!panelHandle;
	}

	// Rex closes the Status block when the renderer exits, including when the
	// user closes the pane. `rex wait` returns then, but its status may be the
	// renderer's own, so `rex block inspect` decides whether the block is gone.
	// Any other result keeps the handle and waits again with backoff.
	function watchRexPanel(handle: RexPanelHandle): void {
		stopRexWatch();
		const watch: RexPanelWatch = {
			handle,
			child: null,
			retryTimer: null,
			retryDelayMs: REX_WATCH_RETRY_MS,
			failureReported: false,
		};
		rexWatch = watch;
		waitForRexPanel(watch);
	}

	function isCurrentRexWatch(watch: RexPanelWatch, child: ChildProcess): boolean {
		return rexWatch === watch && watch.child === child && panelHandle === watch.handle;
	}

	function waitForRexPanel(watch: RexPanelWatch): void {
		const child = spawn("rex", ["wait", "-s", watch.handle.session, watch.handle.ref], { stdio: "ignore" });
		watch.child = child;
		child.unref();
		child.once("error", (error) => {
			if (!isCurrentRexWatch(watch, child)) return;
			watch.child = null;
			reportRexWatchFailure(watch, `rex wait failed: ${error.message}`);
			retryRexWait(watch);
		});
		child.once("exit", (status, signal) => {
			if (!isCurrentRexWatch(watch, child)) return;
			watch.child = null;
			inspectRexPanel(watch, status ?? signal);
		});
	}

	function inspectRexPanel(watch: RexPanelWatch, waitResult: number | NodeJS.Signals | null): void {
		const { session, ref } = watch.handle;
		const args = ["block", "inspect", "-s", session, "-b", ref, "--json"];
		const child = execFile("rex", args, { timeout: 3000 }, (error, _stdout, stderr) => {
			if (!isCurrentRexWatch(watch, child)) return;
			watch.child = null;
			if (isRexTargetMissing(error)) {
				clearPanel();
				return;
			}
			if (error) {
				reportRexWatchFailure(watch, `rex block inspect failed: ${stderr.trim() || error.message}`);
			} else if (waitResult !== 0) {
				// The block is still running, so this status is from `rex wait` itself.
				reportRexWatchFailure(watch, `rex wait exited with ${waitResult}`);
			}
			retryRexWait(watch);
		});
		watch.child = child;
	}

	// Reports once per opened pane; retries continue quietly after that.
	function reportRexWatchFailure(watch: RexPanelWatch, detail: string): void {
		if (watch.failureReported) return;
		watch.failureReported = true;
		footerCtx?.ui.notify(
			`Status panel cannot detect when its Rex pane closes (${detail}); retrying. /status still closes it.`,
			"warning",
		);
	}

	function retryRexWait(watch: RexPanelWatch): void {
		watch.retryTimer = setTimeout(() => {
			watch.retryTimer = null;
			if (rexWatch === watch && panelHandle === watch.handle) waitForRexPanel(watch);
		}, watch.retryDelayMs);
		watch.retryTimer.unref();
		watch.retryDelayMs = Math.min(watch.retryDelayMs * 2, REX_WATCH_MAX_RETRY_MS);
	}

	// Stops only this extension's own `rex wait` or `rex block inspect` child.
	function stopRexWatch(): void {
		const watch = rexWatch;
		if (!watch) return;
		rexWatch = null;
		if (watch.retryTimer) clearTimeout(watch.retryTimer);
		watch.retryTimer = null;
		watch.child?.kill();
		watch.child = null;
	}

	function hideFooter(ctx: ExtensionContext): void {
		if (footerCtx) return;
		ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
		footerCtx = ctx;
	}

	function restoreFooter(): void {
		const ctx = footerCtx;
		if (!ctx) return;
		footerCtx = null;
		ctx.ui.setFooter(undefined);
	}

	function clearPanel(): void {
		panelHandle = null;
		stopRexWatch();
		writePanelState(null);
		restoreFooter();
	}

	function closePanel(): boolean {
		if (!panelHandle) return false;

		const handle = panelHandle;
		if (handle.backend === "rex") {
			// The renderer exits on INT, and Rex closes command blocks when their
			// command exits. A missing block was already closed; keep the handle if
			// Rex fails for any other reason.
			try {
				rexSync(["send-key", "-s", handle.session, "-b", handle.ref, "ctrl+c"]);
			} catch (error) {
				if (!isRexTargetMissing(error)) throw error;
			}
		} else {
			try {
				if (handle.backend === "cmux") {
					execFileSync("cmux", ["close-surface", "--surface", handle.ref, "--force"], { timeout: 2000 });
				} else {
					execFileSync("tmux", ["kill-pane", "-t", handle.ref], { timeout: 2000 });
				}
			} catch {}
		}

		clearPanel();
		return true;
	}

	function togglePanel(ctx: ExtensionContext): boolean {
		if (panelHandle) {
			return closePanel();
		}
		const opened = openPanel(ctx.cwd);
		if (opened) hideFooter(ctx);
		return opened;
	}

	function notifyPanelError(ctx: ExtensionContext, wasOpen: boolean, error: unknown): void {
		ctx.ui.notify(`Status panel ${wasOpen ? "close" : "open"} failed: ${errorMessage(error)}`, "error");
	}

	// Keep the handle on failure so the process-exit fallback can retry. The TUI
	// is still drawn during session_shutdown (for example on reload), but not at
	// process exit.
	function closePanelForShutdown(ctx?: ExtensionContext): void {
		try {
			closePanel();
		} catch (error) {
			if (ctx?.mode === "tui") {
				notifyPanelError(ctx, true, error);
			} else {
				console.error(`Status panel close failed: ${errorMessage(error)}`);
			}
		}
	}

	// Fallback in case session_shutdown doesn't fire or could not close the pane.
	function onProcessExit(): void {
		// The terminal UI is gone at process exit; only the pane needs cleanup.
		footerCtx = null;
		if (panelHandle) {
			closePanelForShutdown();
		}
		stopRexWatch();
		writePanelState(null);
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionDir = getStateDir(ctx.sessionManager.getSessionFile());
		process.off("exit", onProcessExit);
		process.on("exit", onProcessExit);
		if (ctx.mode !== "tui") return;
		if (getMuxBackend() && !panelHandle) {
			try {
				togglePanel(ctx);
			} catch (error) {
				notifyPanelError(ctx, false, error);
			}
		}
	});

	// A failed close keeps the handle and exit listener for the process-exit
	// fallback, but the watcher and hidden footer belong to this session.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (panelHandle) {
			closePanelForShutdown(ctx);
		}
		stopRexWatch();
		restoreFooter();
		writePanelState(null);
		if (!panelHandle) {
			process.off("exit", onProcessExit);
		}
	});

	pi.registerCommand("status", {
		description: "Toggle right status panel (cmux/tmux/Rex split)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Status panel requires the interactive TUI", "warning");
				return;
			}
			if (!getMuxBackend()) {
				ctx.ui.notify("Status panel requires cmux, tmux, or Rex", "warning");
				return;
			}
			const wasOpen = !!panelHandle;
			try {
				const changed = togglePanel(ctx);
				ctx.ui.notify(
					changed ? `Status panel ${wasOpen ? "closing" : "opening"}` : "Status panel unavailable",
					changed ? "info" : "warning",
				);
			} catch (error) {
				notifyPanelError(ctx, wasOpen, error);
			}
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Toggle right status panel",
		handler: async (ctx) => {
			if (getMuxBackend()) {
				const wasOpen = !!panelHandle;
				try {
					togglePanel(ctx);
				} catch (error) {
					notifyPanelError(ctx, wasOpen, error);
				}
			}
		},
	});
}
