/**
 * Session naming example.
 *
 * Shows setSessionName/getSessionName to give sessions friendly names
 * that appear in the session selector instead of the first message.
 *
 * Usage: /session-name [name] - set or show session name
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function syncTmuxSessionName(name: string | undefined): void {
	if (!process.env.TMUX || !process.env.TMUX_PANE) return;

	try {
		if (name) {
			execFileSync("tmux", ["set-option", "-pt", process.env.TMUX_PANE, "@pi_session_name", name], { timeout: 2000 });
		} else {
			execFileSync("tmux", ["set-option", "-pt", process.env.TMUX_PANE, "-u", "@pi_session_name"], { timeout: 2000 });
		}
	} catch {}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		syncTmuxSessionName(pi.getSessionName());
	});
	pi.registerCommand("session-name", {
		description: "Set or show session name (usage: /session-name [new name])",
		handler: async (args, ctx) => {
			const name = args.trim();

			if (name) {
				pi.setSessionName(name);
				syncTmuxSessionName(name);
				ctx.ui.notify(`Session named: ${name}`, "info");
			} else {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			}
		},
	});
}
