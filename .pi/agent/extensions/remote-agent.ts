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
	lastUsedAt: string;
}

const MAX_AGE_DAYS = 3;

function isStale(cs: CodespaceInfo): boolean {
	try {
		const lastUsed = new Date(cs.lastUsedAt).getTime();
		const ageDays = (Date.now() - lastUsed) / (1000 * 60 * 60 * 24);
		return ageDays > MAX_AGE_DAYS;
	} catch {
		return true;
	}
}

function listCodespaces(repo?: string): CodespaceInfo[] {
	try {
		const args = ["cs", "list", "--json", "name,repository,gitStatus,state,lastUsedAt"];
		if (repo) args.push("--repo", repo);
		const out = execFileSync("gh", args, { timeout: 15000, encoding: "utf-8" });
		const list = JSON.parse(out) as Array<{
			name: string;
			repository: string;
			state: string;
			lastUsedAt: string;
			gitStatus: { ref: string };
		}>;
		return list.map((cs) => ({
			name: cs.name,
			repository: cs.repository,
			state: cs.state,
			ref: cs.gitStatus.ref,
			lastUsedAt: cs.lastUsedAt,
		}));
	} catch {
		return [];
	}
}

function findCodespace(repo: string, branch: string): CodespaceInfo | null {
	const all = listCodespaces(repo);
	// Exact match on branch, not stale — prefer Available
	const exact = all.filter((cs) => cs.ref === branch && !isStale(cs));
	if (exact.length > 0) {
		return exact.find((cs) => cs.state === "Available") ?? exact[0];
	}
	// Log for debugging
	const staleExact = all.filter((cs) => cs.ref === branch && isStale(cs));
	if (staleExact.length > 0) {
		cmuxLog(`Skipped stale codespace on "${branch}" (>${MAX_AGE_DAYS}d old)`, "warning");
	} else if (all.length > 0) {
		const refs = all.slice(0, 5).map((cs) => cs.ref).join(", ");
		cmuxLog(`No codespace on "${branch}". Found: ${refs}`, "warning");
	}
	return null;
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
		description: "Run a task in a Codespace: /remote [PR-URL] <task>",
		handler: async (args, ctx) => {
			const input = args?.trim();
			if (!input) {
				ctx.ui.notify("Usage: /remote [PR-URL] <task>", "warning");
				return;
			}

			// Parse PR URL if provided
			const prMatch = input.match(/^(https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+))\s*(.*)/);
			let repo: string;
			let branch: string;
			let task: string;
			let prUrl: string | null = null;
			let checkoutBranch: string | null = null;

			if (prMatch) {
				// PR URL mode: extract repo, get head branch from PR
				prUrl = prMatch[1];
				repo = prMatch[2];
				task = prMatch[4] || `Review and work on PR #${prMatch[3]}`;

				ctx.ui.notify(`Fetching PR #${prMatch[3]} from ${repo}…`, "info");
				cmuxLog(`Fetching PR: ${prUrl}`);

				try {
					const prJson = execFileSync("gh", [
						"pr", "view", prUrl,
						"--json", "headRefName,baseRefName,title",
					], { timeout: 15000, encoding: "utf-8" });
					const pr = JSON.parse(prJson);
					branch = pr.headRefName;
					checkoutBranch = branch;
					ctx.ui.notify(`PR branch: ${branch}`, "info");
					cmuxLog(`PR branch: ${branch} (base: ${pr.baseRefName})`);
				} catch (e) {
					ctx.ui.notify("Failed to fetch PR details", "error");
					return;
				}
			} else {
				// No PR URL — task only, use current repo + branch
				const info = getRepoAndBranch(ctx.cwd);
				if (!info) {
					ctx.ui.notify("Usage: /remote [PR-URL] <task>\nOr run from inside a GitHub repo", "error");
					return;
				}
				repo = info.repo;
				branch = info.branch;
				task = input;
			}

			ctx.ui.notify(`Looking for Codespace on ${repo}@${branch}…`, "info");
			cmuxLog(`Looking for Codespace: ${repo}@${branch}`);

			// Find or create Codespace
			let cs = findCodespace(repo, branch);
			let csName: string;
			let needsCheckout = false;

			if (cs) {
				ctx.ui.notify(`Found Codespace on ${branch}: ${cs.name} (${cs.state})`, "info");
				cmuxLog(`Found on ${branch}: ${cs.name} (${cs.state})`);
				if (cs.state !== "Available") {
					cmuxSetStatus("remote", "starting…", "cloud.fill", "#8e8e93");
					cmuxLog("Codespace will auto-start on SSH connect", "progress");
				}
				csName = cs.name;
			} else if (checkoutBranch) {
				// No codespace on the PR branch — look for one on the default branch
				ctx.ui.notify(`No Codespace on ${branch}, looking for one on default branch…`, "info");
				cmuxLog(`No Codespace on ${branch}, checking default branch`);

				// Find any codespace for this repo (prefer master/main)
				const allCs = listCodespaces(repo);
				const fresh = allCs.filter((c) => !isStale(c));
				const defaultCs = fresh.find((c) =>
					c.ref === "main" || c.ref === "master"
				) ?? fresh[0];

				if (defaultCs) {
					ctx.ui.notify(`Found Codespace on ${defaultCs.ref}: ${defaultCs.name}, will checkout ${branch}`, "info");
					cmuxLog(`Using ${defaultCs.name} (${defaultCs.ref}), will checkout ${branch}`);
					csName = defaultCs.name;
					needsCheckout = true;
				} else {
					// Create on default branch, then checkout
					ctx.ui.notify(`No Codespace for ${repo}, creating one…`, "info");
					cmuxSetStatus("remote", "creating…", "cloud.fill", "#8e8e93");
					cmuxLog("Creating Codespace on default branch…", "progress");
					const name = createCodespace(repo, "main");
					if (!name) {
						ctx.ui.notify("Failed to create Codespace", "error");
						cmuxLog("Failed to create Codespace", "error");
						return;
					}
					csName = name;
					needsCheckout = true;
					ctx.ui.notify(`Created Codespace: ${csName}`, "info");
					cmuxLog(`Created: ${csName}`, "success");
				}
			} else {
				ctx.ui.notify(`No Codespace on ${branch}, creating one…`, "info");
				cmuxSetStatus("remote", "creating…", "cloud.fill", "#8e8e93");
				cmuxLog("Creating Codespace…", "progress");
				const name = createCodespace(repo, branch);
				if (!name) {
					ctx.ui.notify("Failed to create Codespace", "error");
					cmuxLog("Failed to create Codespace", "error");
					return;
				}
				csName = name;
				ctx.ui.notify(`Created Codespace: ${csName}`, "info");
				cmuxLog(`Created: ${csName}`, "success");
			}

			// Checkout PR branch inside the codespace if needed
			if (needsCheckout && checkoutBranch) {
				ctx.ui.notify(`Checking out ${checkoutBranch} in Codespace…`, "info");
				cmuxSetStatus("remote", "checkout…", "cloud.fill", "#8e8e93");
				cmuxLog(`Checking out ${checkoutBranch}…`, "progress");
				try {
					execFileSync("gh", [
						"cs", "ssh", "-c", csName, "--",
						`cd /workspaces/* 2>/dev/null; git fetch origin ${checkoutBranch} && git checkout ${checkoutBranch}`,
					], { timeout: 120000, encoding: "utf-8" });
					cmuxLog(`Checked out ${checkoutBranch}`, "success");
				} catch (e) {
					ctx.ui.notify(`Failed to checkout ${checkoutBranch}`, "error");
					cmuxLog(`Checkout failed: ${checkoutBranch}`, "error");
					return;
				}
			}

			// Run task with live streaming into chat
			ctx.ui.notify(`Running task in ${csName}…`, "info");

			pi.sendMessage({
				customType: "remote-status",
				content: [{ type: "text", text: `☁ Remote task started in Codespace \`${csName}\` on \`${repo}@${branch}\`${prUrl ? ` ([PR](${prUrl}))` : ""}\n\n**Task:** ${task}` }],
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
