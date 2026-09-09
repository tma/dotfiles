/**
 * Session names for /resume and tmux titles.
 *
 * Auto-names unnamed sessions from the first user prompt using a cheap
 * flash/mini model. /session-name still sets or shows the name by hand.
 */

import { execFile, execFileSync } from "node:child_process";
import { accessSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { cleanGeneratedSessionName, heuristicSessionName } from "./lib/session-title.js";

const MAX_WORDS = 6;
const MAX_CHARS = 48;
const PROMPT_CHARS = 1000;
const TITLE_TIMEOUT_MS = 10_000;

const TITLE_SYSTEM_PROMPT = `You name coding-agent sessions.
Reply with ONLY a short Title Case name, 2 to ${MAX_WORDS} words.
No quotes, no punctuation, no explanation.
Capture the user's intent, not a generic topic.`;

const PREFERRED_CHEAP_IDS = [
	"gemini-3.8-flash",
	"gemini-3.7-flash",
	"gemini-3.6-flash",
	"gemini-3.5-flash",
	"mai-code-1.1-flash",
	"mai-code-1-flash",
	"gpt-5.4-nano",
	"gpt-5.4-mini",
	"gpt-5-mini",
	"claude-haiku-4.5",
];

function getStateDir(sessionFile: string | undefined): string {
	if (sessionFile) return path.dirname(sessionFile);
	const ephemeralDir = path.join(os.tmpdir(), `pi-session-${process.pid}`);
	try {
		mkdirSync(ephemeralDir, { recursive: true });
	} catch {}
	return ephemeralDir;
}

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

function cmux(args: string[]): void {
	if (!isCmux()) return;
	execFile("cmux", args, { timeout: 3000 }, () => {});
}

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

function syncSidebarName(name: string | undefined, nameFile: string): void {
	syncTmuxSessionName(name);
	if (nameFile) {
		try {
			if (name) writeFileSync(nameFile, name);
			else unlinkSync(nameFile);
		} catch {}
	}
	if (name) {
		cmux(["set-status", "session", name, "--icon", "text.alignleft", "--color", "#64d2ff"]);
	} else {
		cmux(["clear-status", "session"]);
	}
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join(" ");
}

function firstUserText(branch: SessionEntry[]): string | undefined {
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = contentToText(entry.message.content).trim();
		if (text) return text;
	}
	return undefined;
}


function cheapScore(id: string): number {
	const lower = id.toLowerCase();
	if (/astra|opus|sonnet|sol|terra|luna|grok|codex|fable|kimi/.test(lower)) return 0;

	let family = 0;
	if (/gemini-.*flash/.test(lower)) family = 400_000;
	else if (/mai-code-.*flash/.test(lower)) family = 300_000;
	else if (/gpt-.*nano/.test(lower)) family = 250_000;
	else if (/gpt-.*mini/.test(lower)) family = 200_000;
	else if (/haiku/.test(lower)) family = 150_000;
	else if (/flash/.test(lower)) family = 100_000;
	else return 0;

	const versions = [...lower.matchAll(/(\d+)(?:\.(\d+))?/g)].map((match) => Number(match[1]) * 1000 + Number(match[2] || 0));
	return family + (versions.length > 0 ? Math.max(...versions) : 0);
}

function findCheapModel(ctx: ExtensionContext) {
	const registry = ctx.modelRegistry;
	for (const id of PREFERRED_CHEAP_IDS) {
		const found = registry.find("github-copilot", id);
		if (found) return found;
	}

	const available = typeof registry.getAvailable === "function" ? registry.getAvailable() : [];
	let best: { model: (typeof available)[number]; score: number } | undefined;
	for (const model of available) {
		const score = cheapScore(model.id);
		if (score <= 0) continue;
		if (!best || score > best.score) best = { model, score };
	}
	return best?.model;
}


async function generateLlmTitle(ctx: ExtensionContext, prompt: string, signal: AbortSignal): Promise<string | null> {
	const model = findCheapModel(ctx);
	if (!model) return null;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: prompt.length > PROMPT_CHARS ? `${prompt.slice(0, PROMPT_CHARS)}…` : prompt }],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{ systemPrompt: TITLE_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") return null;
	const raw = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join(" ")
		.trim();
	return raw ? cleanGeneratedSessionName(raw, { maxWords: MAX_WORDS, maxChars: MAX_CHARS }) : null;
}

export default function (pi: ExtensionAPI) {
	let autoNamed = false;
	let titleAbort: AbortController | null = null;
	let nameFile = "";

	const applyName = (name: string | null): void => {
		if (!name || pi.getSessionName()) return;
		pi.setSessionName(name);
		syncSidebarName(name, nameFile);
	};

	const autoName = (ctx: ExtensionContext, prompt: string): void => {
		const fallback = heuristicSessionName(prompt, { maxWords: MAX_WORDS, maxChars: MAX_CHARS });
		titleAbort?.abort();
		const controller = new AbortController();
		titleAbort = controller;
		const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);

		void (async () => {
			let name: string | null = null;
			try {
				name = await generateLlmTitle(ctx, prompt, controller.signal);
			} catch {
				name = null;
			} finally {
				clearTimeout(timer);
			}
			if (titleAbort !== controller) return;
			titleAbort = null;
			applyName(name ?? fallback);
		})();
	};

	pi.on("session_start", async (_event, ctx) => {
		autoNamed = false;
		titleAbort?.abort();
		titleAbort = null;
		nameFile = path.join(getStateDir(ctx.sessionManager.getSessionFile()), `${process.pid}-session-name.txt`);
		syncSidebarName(pi.getSessionName(), nameFile);

		if (pi.getSessionName()) {
			autoNamed = true;
			return;
		}

		const existing = firstUserText(ctx.sessionManager.getBranch());
		if (!existing) return;
		autoNamed = true;
		autoName(ctx, existing);
	});

	pi.on("session_info_changed", async (event) => {
		syncSidebarName(event.name, nameFile);
		if (event.name) autoNamed = true;
	});

	pi.on("session_shutdown", async () => {
		titleAbort?.abort();
		titleAbort = null;
	});

	pi.on("input", async (event, ctx) => {
		if (autoNamed || pi.getSessionName()) return;
		if (event.source === "extension") return;
		const text = event.text.trim();
		if (!text || text.startsWith("/")) return;
		autoNamed = true;
		autoName(ctx, text);
	});

	pi.registerCommand("session-name", {
		description: "Set or show session name (usage: /session-name [new name | clear])",
		handler: async (args, ctx) => {
			const name = args.trim();

			if (!name) {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
				return;
			}

			if (name === "clear") {
				autoNamed = true;
				titleAbort?.abort();
				titleAbort = null;
				pi.setSessionName("");
				syncSidebarName(undefined, nameFile);
				ctx.ui.notify("Session name cleared", "info");
				return;
			}

			autoNamed = true;
			titleAbort?.abort();
			titleAbort = null;
			pi.setSessionName(name);
			syncSidebarName(name, nameFile);
			ctx.ui.notify(`Session named: ${name}`, "info");
		},
	});
}
