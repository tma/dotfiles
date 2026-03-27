/**
 * Remote Subagent Extension
 *
 * Runs Pi subagents inside GitHub Codespaces. Uses existing Codespaces
 * matching the current repo + branch, or creates new ones.
 *
 * Usage in subagent tool:
 *   { agent: "coder", task: "implement auth", remote: true }
 *   { tasks: [{ agent: "coder", task: "...", remote: true }] }
 *
 * Or via command:
 *   /remote <agent> <task>
 */

import { spawn, execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
	// Prefer an existing Codespace on the same branch
	return all.find((cs) => cs.ref === branch) ?? null;
}

function ensureCodespaceRunning(cs: CodespaceInfo): boolean {
	if (cs.state === "Available") return true;
	try {
		execFileSync("gh", ["cs", "start", "--codespace", cs.name], {
			timeout: 120000,
			encoding: "utf-8",
		});
		return true;
	} catch {
		return false;
	}
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
		// Extract owner/repo from HTTPS or SSH URL
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

// ── Remote agent execution ───────────────────────────────────────────────────

interface RemoteRunResult {
	codespace: string;
	exitCode: number;
	output: string;
	stderr: string;
}

async function runRemoteAgent(
	codespace: string,
	agentPrompt: string,
	signal?: AbortSignal,
	onOutput?: (line: string) => void,
): Promise<RemoteRunResult> {
	const piArgs = [
		"--mode", "json",
		"-p",
		"--no-session",
		agentPrompt,
	];

	const sshCmd = `pi ${piArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;

	return new Promise<RemoteRunResult>((resolve) => {
		const proc = spawn("gh", ["cs", "ssh", "--codespace", codespace, "--", sshCmd], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let lastOutput = "";

		proc.stdout.on("data", (data: Buffer) => {
			const chunk = data.toString();
			stdout += chunk;

			// Parse JSON lines for streaming output
			for (const line of chunk.split("\n")) {
				if (!line.trim()) continue;
				try {
					const ev = JSON.parse(line);
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						for (const part of ev.message.content ?? []) {
							if (part.type === "text") lastOutput = part.text;
						}
					}
					onOutput?.(line);
				} catch {}
			}
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({
				codespace,
				exitCode: code ?? 1,
				output: lastOutput || stdout,
				stderr,
			});
		});

		proc.on("error", () => {
			resolve({ codespace, exitCode: 1, output: "", stderr: "Failed to spawn gh cs ssh" });
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

			// Find or create Codespace
			let cs = findCodespace(info.repo, info.branch);
			let csName: string;

			if (cs) {
				ctx.ui.notify(`Found Codespace: ${cs.name} (${cs.state})`, "info");
				if (!ensureCodespaceRunning(cs)) {
					ctx.ui.notify(`Failed to start Codespace ${cs.name}`, "error");
					return;
				}
				csName = cs.name;
			} else {
				ctx.ui.notify(`No Codespace on ${info.branch}, creating one…`, "info");
				const name = createCodespace(info.repo, info.branch);
				if (!name) {
					ctx.ui.notify("Failed to create Codespace", "error");
					return;
				}
				csName = name;
				ctx.ui.notify(`Created Codespace: ${csName}`, "info");
			}

			// Run task
			ctx.ui.notify(`Running task in ${csName}…`, "info");

			pi.sendUserMessage(
				`A remote task is running in Codespace \`${csName}\` on \`${info.repo}@${info.branch}\`.\n\nTask: ${task}\n\nI'll report the results when it completes.`,
			);

			const result = await runRemoteAgent(csName, task);

			if (result.exitCode === 0) {
				pi.sendUserMessage(
					`Remote task completed in Codespace \`${csName}\`.\n\nResult:\n${result.output.slice(0, 4000)}`,
				);
			} else {
				pi.sendUserMessage(
					`Remote task failed in Codespace \`${csName}\` (exit ${result.exitCode}).\n\nOutput:\n${result.output.slice(0, 2000)}\n\nStderr:\n${result.stderr.slice(0, 2000)}`,
				);
			}
		},
	});
}
