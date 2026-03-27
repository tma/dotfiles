/**
 * Steering Resume Extension
 *
 * When a steering message interrupts the agent mid-task, wraps it with
 * a reminder to resume the original task afterward. Prevents the agent
 * from losing track of what it was doing before the interruption.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let hasPendingSteering = false;

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

			const addendum =
				"\n\nAfter addressing the above, resume the task you were working on before this interruption. " +
				"Do not ask what to do next — continue where you left off. " +
				"If there is an active todo list, consider whether this steering request should be added as a new task — " +
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
