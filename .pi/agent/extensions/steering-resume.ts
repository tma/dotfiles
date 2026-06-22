/**
 * Steering Resume Extension
 *
 * When a steering message interrupts the agent mid-task, wraps it with
 * a reminder to resume the original task afterward. Prevents the agent
 * from losing track of what it was doing before the interruption.
 *
 * Captures the original task from the first user message in each agent
 * loop so the resume instruction survives context compaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let hasPendingSteering = false;
	let originalTask = "";

	pi.on("agent_start", async (_event, ctx) => {
		// Capture the original task from the last user message in the branch
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "user") continue;
			const parts = Array.isArray(msg.content) ? msg.content : [];
			const textPart = parts.find((p: any) => p.type === "text");
			if (textPart) {
				// Truncate to keep the addendum reasonable
				const text = textPart.text.trim();
				originalTask = text.length > 200 ? text.slice(0, 200) + "…" : text;
				break;
			}
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return;
		if (ctx.isIdle()) return;
		if (!event.text.trim() || event.text.startsWith("/")) return;

		hasPendingSteering = true;
	});

	pi.on("context", async (event) => {
		if (!hasPendingSteering) return;

		// Find the last user message and append resume instruction
		const messages = [...event.messages];
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "user") continue;
			const parts = Array.isArray(m.content) ? m.content : [];
			const textPart = parts.find((p: any) => p.type === "text");
			if (!textPart) continue;

			let addendum =
				"\n\nAfter addressing the above, resume the task you were working on before this interruption. " +
				"Do not ask what to do next — continue where you left off.";

			if (originalTask) {
				addendum += ` The original task was: "${originalTask}"`;
			}

			addendum +=
				" If there is an active todo list, consider whether this steering request should be added as a new task — " +
				"either after the current in-progress task or at the end of the list.";

			messages[i] = {
				...m,
				content: parts.map((p: any) =>
					p === textPart ? { ...p, text: p.text + addendum } : p,
				),
			};
			hasPendingSteering = false;
			return { messages };
		}
	});
}
