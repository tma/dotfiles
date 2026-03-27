/**
 * Remote Subagent Extension
 *
 * Runs Pi subagents inside GitHub Codespaces. Uses existing Codespaces
 * matching the current repo + branch, or creates new ones.
 *
 * Live streams events to cmux sidebar: tool calls, file edits,
 * progress, errors — same visibility as local agents.
 *
 * Usage:
 *   /remote <task>
 */

import { spawn, execFileSync, execFile } from "node:child_process";
import { accessSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── cmux helpers ─────────────────────────────────────────────────────────────

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

function cmuxNotify(title: string, body: string, subtitle?: string): void {
	const args = ["notify", "--title", title, "--body", body];
	if (subtitle) args.push("--subtitle", subtitle);
	cmux(args);
}

function cmuxSetStatus(key: string, value: string, icon?: string, color?: string): void {
	const args = ["set-status", key, value];
	if (icon) args.push("--icon", icon);
	if (color) args.push("--color", color);
	cmux(args);
}

function cmuxClearStatus(key: string): void {
	cmux(["clear-status", key]);
}

function cmuxLog(message: string, level: string = "info"): void {
	cmux(["log", "--level", level, "--source", "remote", "--", message]);
}

function cmuxSetProgress(value: number, label?: string): void {
	const args = ["set-progress", String(Math.min(1, Math.max(0, value)))];
	if (label) args.push("--label", label);
	cmux(args);
}

function cmuxClearProgress(): void {
	cmux(["clear-progress"]);
}

// ── Codespace helpers ────────────────────────────────────────────────────────

interface CodespaceInfo {
	name: string;
	repository: string;
	state: string;
	ref: string;
}

function listCodespaces(repo?: string): CodespaceInfo[] {
	try {
		const args = ["cs", "list", "--json", "name,repository,gitStatus,state"];
		if (repo) args.push("--repo", repo);
		const out = execFileSync("gh", args, { timeout: 15000, encoding: "utf-8" });
		const list = JSON.parse(out) as Array<{
			name: string;
			repository: string;
			state: string;
			gitStatus: { ref: string };
		}>;
		return list.map((cs) => ({
			name: cs.name,
			repository: cs.repository,
			state: cs.state,
			ref: cs.gitStatus.ref,
		}));
	} catch {
		return [];
	}
}

function findCodespace(repo: string, branch: string): CodespaceInfo | null {
	const all = listCodespaces(repo);
	return all.find((cs) => cs.ref === branch) ?? null;
}

function ensureCodespaceRunning(cs: CodespaceInfo): boolean {
	if (cs.state === "Available") return true;
	// No explicit start command — SSH auto-starts stopped codespaces.
	// Just return true and let the SSH connection handle it.
	return true;
}

function createCodespace(repo: string, branch: string): string | null {
	try {
		const out = execFileSync(
			"gh",
			["cs", "create", "--repo", repo, "--branch", branch, "--json", "name", "--default-permissions"],
			{ timeout: 120000, encoding: "utf-8" },
		);
		const parsed = JSON.parse(out);
		return parsed.name ?? null;
	} catch {
		return null;
	}
}

function getRepoAndBranch(cwd: string): { repo: string; branch: string } | null {
	try {
		const remote = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd,
			timeout: 5000,
			encoding: "utf-8",
		}).trim();
		const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
		if (!match) return null;
		const repo = match[1];

		const branch = execFileSync("git", ["branch", "--show-current"], {
			cwd,
			timeout: 5000,
			encoding: "utf-8",
		}).trim();

		return { repo, branch };
	} catch {
		return null;
	}
}

// ── Remote agent execution with live streaming ───────────────────────────────

interface RemoteRunResult {
	codespace: string;
	exitCode: number;
	output: string;
	stderr: string;
	turns: number;
	toolCalls: number;
}

function basename(p: string): string {
	return p.split("/").pop() ?? p;
}

async function runRemoteAgent(
	codespace: string,
	agentPrompt: string,
	signal?: AbortSignal,
	onEvent?: (ev: any) => void,
): Promise<RemoteRunResult> {
	const piArgs = [
		"--mode", "json",
		"-p",
		"--no-session",
		agentPrompt,
	];

	const sshCmd = `pi ${piArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;

	// Start cmux tracking
	cmuxSetStatus("remote", `${codespace.slice(0, 20)}…`, "cloud.fill", "#5856d6");
	cmuxSetProgress(0, "Remote: connecting…");
	cmuxLog(`Codespace: ${codespace}`);

	const startTime = Date.now();
	let turns = 0;
	let toolCalls = 0;

	return new Promise<RemoteRunResult>((resolve) => {
		const proc = spawn("gh", ["cs", "ssh", "--codespace", codespace, "--", sshCmd], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let lastOutput = "";
		let lineBuf = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}

			onEvent?.(ev);

			// Track tool calls → cmux log + status
			if (ev.type === "tool_execution_start") {
				toolCalls++;
				const name = ev.toolName;
				const args = ev.args ?? {};

				if (name === "bash") {
					const cmd = String(args.command ?? "").slice(0, 50);
					cmuxLog(`☁ $ ${cmd}${cmd.length >= 50 ? "…" : ""}`, "progress");
					cmuxSetStatus("remote", "bash", "cloud.fill", "#5856d6");
				} else if (name === "edit") {
					cmuxLog(`☁ edit: ${basename(String(args.path ?? ""))}`, "progress");
					cmuxSetStatus("remote", "edit", "cloud.fill", "#5856d6");
				} else if (name === "write") {
					cmuxLog(`☁ write: ${basename(String(args.path ?? ""))}`, "progress");
					cmuxSetStatus("remote", "write", "cloud.fill", "#5856d6");
				} else if (name === "read") {
					cmuxLog(`☁ read: ${basename(String(args.path ?? ""))}`, "info");
				}
			}

			// Track tool errors
			if (ev.type === "tool_execution_end" && ev.isError) {
				cmuxLog(`☁ ✗ ${ev.toolName} failed`, "error");
				cmuxSetStatus("remote", "error", "cloud.fill", "#ff3b30");
				setTimeout(() => {
					cmuxSetStatus("remote", "working", "cloud.fill", "#5856d6");
				}, 3000);
			}

			// Track turns
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				turns++;
				cmuxSetProgress(Math.min(0.9, turns / 10), `Remote: turn ${turns}`);

				for (const part of ev.message.content ?? []) {
					if (part.type === "text") lastOutput = part.text;
				}
			}

			// Track turn start
			if (ev.type === "turn_start") {
				cmuxSetStatus("remote", `turn ${(ev.turnIndex ?? 0) + 1}`, "cloud.fill", "#5856d6");
			}
		};

		proc.stdout.on("data", (data: Buffer) => {
			const chunk = data.toString();
			stdout += chunk;
			lineBuf += chunk;
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (lineBuf.trim()) processLine(lineBuf);

			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			cmuxClearProgress();

			if (code === 0) {
				cmuxSetStatus("remote", "done", "checkmark.cloud.fill", "#34c759");
				cmuxLog(`☁ Done — ${turns} turns, ${toolCalls} tools, ${elapsed}s`, "success");
				cmuxNotify("Pi (remote)", `Done — ${turns} turns, ${elapsed}s`);
			} else {
				cmuxSetStatus("remote", "failed", "xmark.cloud.fill", "#ff3b30");
				cmuxLog(`☁ Failed (exit ${code}) — ${elapsed}s`, "error");
				cmuxNotify("Pi (remote)", `Failed (exit ${code})`, "Error");
			}

			// Fade status after 10s
			setTimeout(() => cmuxClearStatus("remote"), 10000);

			resolve({
				codespace,
				exitCode: code ?? 1,
				output: lastOutput || stdout,
				stderr,
				turns,
				toolCalls,
			});
		});

		proc.on("error", () => {
			cmuxClearProgress();
			cmuxSetStatus("remote", "failed", "xmark.cloud.fill", "#ff3b30");
			cmuxLog("☁ Failed to connect", "error");
			setTimeout(() => cmuxClearStatus("remote"), 10000);
			resolve({ codespace, exitCode: 1, output: "", stderr: "Failed to spawn gh cs ssh", turns: 0, toolCalls: 0 });
		});

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	pi.registerCommand("remote", {
		description: "Run a task in a Codespace: /remote <task>",
		handler: async (args, ctx) => {
			const task = args?.trim();
			if (!task) {
				ctx.ui.notify("Usage: /remote <task>", "warning");
				return;
			}

			const info = getRepoAndBranch(ctx.cwd);
			if (!info) {
				ctx.ui.notify("Not in a GitHub repo", "error");
				return;
			}

			ctx.ui.notify(`Looking for Codespace on ${info.repo}@${info.branch}…`, "info");
			cmuxLog(`Looking for Codespace: ${info.repo}@${info.branch}`);

			// Find or create Codespace
			let cs = findCodespace(info.repo, info.branch);
			let csName: string;

			if (cs) {
				ctx.ui.notify(`Found Codespace: ${cs.name} (${cs.state})`, "info");
				cmuxLog(`Found: ${cs.name} (${cs.state})`);
				if (cs.state !== "Available") {
					cmuxSetStatus("remote", "starting…", "cloud.fill", "#8e8e93");
					cmuxLog("Codespace will auto-start on SSH connect", "progress");
				}
				csName = cs.name;
			} else {
				ctx.ui.notify(`No Codespace on ${info.branch}, creating one…`, "info");
				cmuxSetStatus("remote", "creating…", "cloud.fill", "#8e8e93");
				cmuxLog("Creating Codespace…", "progress");
				const name = createCodespace(info.repo, info.branch);
				if (!name) {
					ctx.ui.notify("Failed to create Codespace", "error");
					cmuxLog("Failed to create Codespace", "error");
					return;
				}
				csName = name;
				ctx.ui.notify(`Created Codespace: ${csName}`, "info");
				cmuxLog(`Created: ${csName}`, "success");
			}

			// Run task with live streaming into chat
			ctx.ui.notify(`Running task in ${csName}…`, "info");

			pi.sendMessage({
				customType: "remote-status",
				content: [{ type: "text", text: `☁ Remote task started in Codespace \`${csName}\` on \`${info.repo}@${info.branch}\`\n\n**Task:** ${task}` }],
				display: "user",
			});

			let lastReportedTurn = 0;

			const result = await runRemoteAgent(csName, task, undefined, (ev) => {
				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					lastReportedTurn++;

					// Collect tool calls from this turn
					const tools: string[] = [];
					let text = "";
					for (const part of ev.message.content ?? []) {
						if (part.type === "toolCall") {
							const args = part.arguments as Record<string, unknown>;
							if (part.name === "bash") {
								tools.push(`$ ${String(args.command ?? "").slice(0, 80)}`);
							} else if (part.name === "edit" || part.name === "write" || part.name === "read") {
								tools.push(`${part.name}: ${basename(String(args.path ?? ""))}`);
							} else {
								tools.push(part.name);
							}
						}
						if (part.type === "text") text = part.text;
					}

					const preview = text.length > 300 ? text.slice(0, 300) + "…" : text;
					let summary = `**☁ Turn ${lastReportedTurn}**`;
					if (tools.length > 0) summary += `  ·  ${tools.join("  ·  ")}`;
					if (preview) summary += `\n> ${preview.replace(/\n/g, "\n> ")}`;

					pi.sendMessage({
						customType: "remote-turn",
						content: [{ type: "text", text: summary }],
						display: "user",
					});
				}
			});

			if (result.exitCode === 0) {
				pi.sendMessage({
					customType: "remote-status",
					content: [{ type: "text", text: `☁ **Remote task completed** in \`${csName}\` — ${result.turns} turns, ${result.toolCalls} tool calls.\n\n${result.output.slice(0, 4000)}` }],
					display: "user",
				});
			} else {
				pi.sendMessage({
					customType: "remote-status",
					content: [{ type: "text", text: `☁ **Remote task failed** in \`${csName}\` (exit ${result.exitCode})\n\nOutput:\n${result.output.slice(0, 2000)}\n\nStderr:\n${result.stderr.slice(0, 2000)}` }],
					display: "user",
				});
			}
		},
	});
}
