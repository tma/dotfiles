/**
 * /worktree command — create an isolated git worktree for a task.
 *
 * This is intentionally conservative: it provisions the worktree and keeps the
 * current Pi session intact. When running inside cmux, it launches a new Pi
 * session in a new workspace for the new worktree. By default that session
 * opens idle without sending the task to the model; pass --autopilot to opt
 * into autonomous execution.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 48);
	return slug || "task";
}

function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCmux(): boolean {
	if (process.env.CMUX_WORKSPACE_ID) return true;
	try {
		const sockPath = process.env.CMUX_SOCKET_PATH
			?? `${process.env.HOME}/Library/Application Support/cmux/cmux.sock`;
		fs.accessSync(sockPath);
		return true;
	} catch {
		return false;
	}
}

function getWorktreesRoot(gitRoot: string): string {
	const repoName = path.basename(gitRoot);
	return path.join(path.dirname(gitRoot), `${repoName}-worktrees`);
}

type LaunchMode = "chat" | "autopilot";

function formatPiCommand(task: string, launchMode: LaunchMode): string {
	return launchMode === "autopilot"
		? `pi ${shellQuote(`/autopilot ${task}`)}`
		: "pi";
}

function formatLaunchCommand(worktreePath: string, task: string, launchMode: LaunchMode): string {
	return `cd ${shellQuote(worktreePath)} && ${formatPiCommand(task, launchMode)}`;
}

function parseWorktreeArgs(rawArgs?: string): { task: string; launchMode: LaunchMode } {
	const args = rawArgs?.trim() || "";
	if (!args) return { task: "", launchMode: "chat" };
	if (args === "--autopilot") return { task: "", launchMode: "autopilot" };
	if (args.startsWith("--autopilot ")) {
		return { task: args.slice("--autopilot".length).trim(), launchMode: "autopilot" };
	}
	return { task: args, launchMode: "chat" };
}

function extractWorkspaceRef(output: string): string | null {
	const match = output.match(/workspace:(\S+)/);
	return match ? `workspace:${match[1]}` : null;
}

function getWorkspaceTitle(worktreePath: string): string {
	const repoWorktreesDir = path.basename(path.dirname(worktreePath));
	const repoName = repoWorktreesDir.replace(/-worktrees$/, "");
	const slug = path.basename(worktreePath);
	return `${repoName} · ${slug}`;
}

export default function (pi: ExtensionAPI) {
	async function localBranchExists(branchName: string): Promise<boolean> {
		const { code } = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
		return code === 0;
	}

	async function getUniqueTarget(gitRoot: string, task: string): Promise<{
		slug: string;
		branchName: string;
		worktreePath: string;
	}> {
		const worktreesRoot = getWorktreesRoot(gitRoot);
		const baseSlug = slugify(task);

		let slug = baseSlug;
		let branchName = `wt/${slug}`;
		let worktreePath = path.join(worktreesRoot, slug);
		let suffix = 2;

		while (fs.existsSync(worktreePath) || (await localBranchExists(branchName))) {
			slug = `${baseSlug}-${suffix}`;
			branchName = `wt/${slug}`;
			worktreePath = path.join(worktreesRoot, slug);
			suffix++;
		}

		return { slug, branchName, worktreePath };
	}

	async function launchPiInCmuxWorkspace(worktreePath: string, task: string, launchMode: LaunchMode): Promise<{ launched: boolean; workspaceRef?: string; workspaceTitle?: string; error?: string }> {
		if (!isCmux()) return { launched: false };

		const piCommand = formatPiCommand(task, launchMode);
		const createResult = await pi.exec("cmux", [
			"new-workspace",
			"--cwd",
			worktreePath,
			"--command",
			piCommand,
		]);
		if (createResult.code !== 0) {
			return {
				launched: false,
				error: createResult.stderr.trim() || createResult.stdout.trim() || "failed to create cmux workspace",
			};
		}

		const workspaceRef = extractWorkspaceRef(createResult.stdout || createResult.stderr || "") ?? undefined;
		const workspaceTitle = getWorkspaceTitle(worktreePath);
		if (workspaceRef) {
			await sleep(200);
			await pi.exec("cmux", ["rename-workspace", "--workspace", workspaceRef, workspaceTitle]);
		}

		return { launched: true, workspaceRef, workspaceTitle };
	}

	pi.registerCommand("worktree", {
		description:
			"Create a new git worktree for a task and launch idle Pi there; use --autopilot to start work: /worktree [--autopilot] <task>",
		handler: async (args, ctx) => {
			const parsedArgs = parseWorktreeArgs(args);
			let task = parsedArgs.task;
			const launchMode = parsedArgs.launchMode;
			if (!task && ctx.hasUI) {
				task = (await ctx.ui.input("New worktree task", "add oauth login"))?.trim() || "";
			}

			if (!task) {
				ctx.ui.notify("Usage: /worktree [--autopilot] <task>", "warning");
				return;
			}

			const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
			if (rootResult.code !== 0) {
				ctx.ui.notify("/worktree requires a git repository", "error");
				return;
			}
			const gitRoot = rootResult.stdout.trim();

			const branchResult = await pi.exec("git", ["branch", "--show-current"]);
			const currentBranch = branchResult.stdout.trim();
			const baseRef = currentBranch || "HEAD";

			const statusResult = await pi.exec("git", ["status", "--porcelain"]);
			const isDirty = statusResult.stdout.trim().length > 0;
			if (isDirty && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Current worktree has uncommitted changes",
					[
						`The new worktree will be created from ${baseRef} at HEAD only.`,
						"Uncommitted changes in the current checkout will not be copied.",
						"Continue?",
					].join("\n\n"),
				);
				if (!ok) return;
			}

			const { branchName, worktreePath } = await getUniqueTarget(gitRoot, task);
			fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

			const addResult = await pi.exec("git", ["worktree", "add", "-b", branchName, worktreePath]);
			if (addResult.code !== 0) {
				const reason = addResult.stderr.trim() || addResult.stdout.trim() || "git worktree add failed";
				ctx.ui.notify(reason, "error");
				return;
			}

			const launchCommand = formatLaunchCommand(worktreePath, task, launchMode);
			const autopilotCommand = launchMode === "chat"
				? formatLaunchCommand(worktreePath, task, "autopilot")
				: undefined;
			const launchResult = await launchPiInCmuxWorkspace(worktreePath, task, launchMode);
			const launchedInCmux = launchResult.launched;
			const message = [
				`🌱 Created worktree \`${worktreePath}\``,
				"",
				`- Branch: \`${branchName}\``,
				`- Base: \`${baseRef}\``,
				`- Launch mode: \`${launchMode}\``,
				isDirty ? "- Note: uncommitted changes in the current checkout were not copied" : "",
				launchedInCmux
					? `- Launched: new Pi session in ${launchResult.workspaceTitle ?? "a new workspace"}${launchResult.workspaceRef ? ` (${launchResult.workspaceRef})` : ""}`
					: "",
				!launchedInCmux && launchResult.error ? `- Launch error: ${launchResult.error}` : "",
				"",
				launchedInCmux ? "Fallback / manual launch:" : "Suggested next step:",
				"```bash",
				launchCommand,
				"```",
				autopilotCommand ? "Optional autopilot launch:" : "",
				autopilotCommand ? "```bash" : "",
				autopilotCommand ?? "",
				autopilotCommand ? "```" : "",
			].filter(Boolean).join("\n");

			pi.sendMessage({
				customType: "worktree-status",
				content: [{ type: "text", text: message }],
				display: "user",
			});
			ctx.ui.notify(
				launchedInCmux ? `Worktree created and launched: ${branchName}` : `Worktree created: ${branchName}`,
				"info",
			);
		},
	});
}
