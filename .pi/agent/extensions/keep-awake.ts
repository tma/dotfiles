/**
 * Prevent idle system sleep on macOS while Pi is doing work.
 *
 * `caffeinate -i` blocks idle sleep but lets the display turn off. `-w` ties
 * the assertion to this Pi process, so macOS releases it even if Pi exits
 * without running cleanup. An idle prompt does not hold an assertion.
 *
 * The extension holds one assertion from `agent_start` until `agent_settled`,
 * which covers retries, in-run compaction, and queued continuations. A second,
 * independent assertion spans each compaction from `session_before_compact`
 * until `session_compact` or `session_compact_failed`, which covers manual and
 * pre-run compaction that happen outside an agent run. Background
 * subagent jobs hold their own assertions through `startKeepAwake()`, because
 * their children run without extensions.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Starts an assertion and returns an idempotent function that releases it. No-op outside macOS. */
export function startKeepAwake(ctx: ExtensionContext): () => void {
	if (process.platform !== "darwin") return () => {};

	function report(message: string) {
		try {
			if (ctx.hasUI) {
				ctx.ui.notify(message, "warning");
				return;
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			process.stderr.write(`keep-awake: ${message} (notification failed: ${reason})\n`);
			return;
		}
		process.stderr.write(`keep-awake: ${message}\n`);
	}

	let stopping = false;
	let child: ChildProcess;
	try {
		child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
			stdio: ["ignore", "ignore", "inherit"],
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		report(`Could not start /usr/bin/caffeinate, so the Mac may sleep while Pi works: ${reason}`);
		return () => {};
	}
	child.unref();

	child.on("error", (error) => {
		if (stopping) return;
		report(`Could not start /usr/bin/caffeinate, so the Mac may sleep while Pi works: ${error.message}`);
	});
	child.on("exit", (code, signal) => {
		if (stopping) return;
		report(`/usr/bin/caffeinate exited unexpectedly (${signal ?? `code ${code}`}), so the Mac may sleep while Pi works.`);
	});

	return () => {
		if (stopping) return;
		stopping = true;
		child.kill();
	};
}

export default function (pi: ExtensionAPI) {
	if (process.platform !== "darwin") return;

	let stopRun: (() => void) | undefined;
	let stopCompaction: (() => void) | undefined;

	function releaseRun() {
		const stopCurrent = stopRun;
		stopRun = undefined;
		stopCurrent?.();
	}

	function releaseCompaction() {
		const stopCurrent = stopCompaction;
		stopCompaction = undefined;
		stopCurrent?.();
	}

	pi.on("agent_start", (_event, ctx) => {
		if (stopRun) return;
		stopRun = startKeepAwake(ctx);
	});
	pi.on("session_before_compact", (_event, ctx) => {
		if (stopCompaction) return;
		stopCompaction = startKeepAwake(ctx);
	});

	pi.on("agent_settled", releaseRun);
	pi.on("session_compact", releaseCompaction);
	pi.on("session_compact_failed", releaseCompaction);
	pi.on("session_shutdown", () => {
		releaseRun();
		releaseCompaction();
	});
}
