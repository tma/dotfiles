/**
 * Pi Status Panel Extension
 *
 * Opens a cmux right split pane showing modified files, git status,
 * diff stats, and recent commits — like OpenCode's right sidebar.
 *
 * Toggle with /status or ctrl+shift+s.
 * Requires cmux. Falls back to widget above editor otherwise.
 */

import { execFile, execFileSync } from "node:child_process";
import { accessSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

function cmuxSync(args: string[]): string | null {
	try {
		return execFileSync("cmux", args, { timeout: 3000, encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	let panelSurfaceId: string | null = null;
	const scriptPath = path.join(path.dirname(import.meta.url.replace("file://", "")), "status-panel.sh");

	function openPanel(cwd: string): boolean {
		if (!isCmux()) return false;

		// Create a right split — returns "OK surface:<id> workspace:<id>"
		const result = cmuxSync(["new-split", "right"]);
		if (!result) return false;

		// Parse surface ID from response
		const match = result.match(/surface:(\S+)/);
		if (match) panelSurfaceId = `surface:${match[1]}`;

		if (!panelSurfaceId) return false;

		// Send cd + script to the new surface and press enter
		setTimeout(() => {
			const cmd = `cd ${cwd.replace(/ /g, "\\ ")} && ${scriptPath}`;
			execFile("cmux", ["send", "--surface", panelSurfaceId!, cmd], { timeout: 3000 }, () => {});
			setTimeout(() => {
				execFile("cmux", ["send-key", "--surface", panelSurfaceId!, "enter"], { timeout: 3000 }, () => {});
			}, 100);
		}, 300);

		return true;
	}

	function closePanel(): boolean {
		if (!isCmux() || !panelSurfaceId) return false;

		// Close synchronously — Pi may be exiting
		try {
			execFileSync("cmux", ["close-surface", "--surface", panelSurfaceId], { timeout: 2000 });
		} catch {}
		panelSurfaceId = null;

		return true;
	}

	function togglePanel(cwd: string): boolean {
		if (panelSurfaceId) {
			return closePanel();
		} else {
			return openPanel(cwd);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (isCmux() && !panelSurfaceId) {
			togglePanel(ctx.cwd);
		}
	});

	pi.on("session_shutdown", async () => {
		if (panelSurfaceId) {
			closePanel();
		}
	});

	// Fallback: catch process exit in case session_shutdown doesn't fire
	process.on("exit", () => {
		if (panelSurfaceId) {
			closePanel();
		}
	});

	pi.registerCommand("status", {
		description: "Toggle right status panel (cmux split)",
		handler: async (_args, ctx) => {
			if (!isCmux()) {
				ctx.ui.notify("Status panel requires cmux", "warning");
				return;
			}
			const wasOpen = !!panelSurfaceId;
			togglePanel(ctx.cwd);
			ctx.ui.notify(`Status panel ${wasOpen ? "closing" : "opening"}`, "info");
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Toggle right status panel",
		handler: async (ctx) => {
			if (isCmux()) {
				togglePanel(ctx.cwd);
			}
		},
	});
}
