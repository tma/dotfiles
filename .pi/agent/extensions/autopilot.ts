/**
 * /autopilot command — create a plan and execute it in the current worktree.
 *
 * With args:  /autopilot <task> — analyze, plan, execute, and verify in one flow
 * Without:    /autopilot — execute existing worktree-local .pi/plan.md, or derive one from conversation first
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLAN_FORMAT, ensurePlanIgnored, findPlanFile, getPlanPath } from "./plan.js";

function buildAutopilotPrompt(
	cwd: string,
	planPath: string,
	task?: string,
	existingPlan?: string | null,
): string {
	const worktreeContext = `## Current worktree
- Working directory: ${cwd}
- Plan file: ${planPath}
- Treat the plan file as worktree-local state for this checkout.
- The plan file must never be committed.
- Stay in this worktree. Do NOT create, switch, or remove git worktrees unless the user explicitly asks.`;

	const executionRules = `## Execution rules
1. Do the initial planning pass yourself in this context window (use read, grep, find, ls directly — do NOT delegate the initial planning pass).
2. Use todo_write when the work spans 3+ steps or multiple files.
3. After the plan exists, execute it using the subagent tool where that helps: parallel for independent work, chain for dependent work, single agent when appropriate.
4. Follow the plan's Execution Strategy section during execution.
5. If you learn something important while implementing, update ${planPath} before continuing so the plan stays accurate for this worktree.
6. Run reasonable verification commands for the touched codepaths when available, and fix failures you introduced.
7. Do NOT stop after planning. Continue through execution until the task is complete or genuinely blocked.`;

	if (task) {
		const overwriteNote = existingPlan
			? `\n\nNote: A plan already exists at ${existingPlan}. Overwrite it with the new plan before execution.`
			: "";

		return `Autonomously execute this task in the current worktree.

${worktreeContext}${overwriteNote}

## Workflow
1. Analyze the codebase for the task below.
2. Write a structured implementation plan to ${planPath} using the exact format below.
3. Execute that plan in this same worktree.

${executionRules}

## Plan format
${PLAN_FORMAT}

## Task
${task}`;
	}

	if (existingPlan) {
		return `Autonomously execute the existing plan in the current worktree.

${worktreeContext}

## Workflow
1. Read ${existingPlan} and treat it as the source of truth for this checkout.
2. Execute it in this same worktree.
3. Only revise the plan if it is clearly stale, incomplete, or contradicted by the codebase.

${executionRules}

Do NOT re-plan from scratch unless necessary. Start by reading ${existingPlan}.`;
	}

	return `Autonomously continue from our current conversation in the current worktree.

${worktreeContext}

## Workflow
1. Review our conversation and the codebase.
2. Write a structured implementation plan to ${planPath} using the exact format below.
3. Execute that plan in this same worktree.

${executionRules}

## Plan format
${PLAN_FORMAT}

Do NOT just summarize the conversation. Write the plan file and continue through execution.`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("autopilot", {
		description:
			"Plan and execute work autonomously in the current worktree: /autopilot [task]",
		handler: async (args, ctx) => {
			const task = args?.trim() || undefined;
			const planPath = getPlanPath(ctx.cwd);
			const existingPlan = findPlanFile(ctx.cwd);
			await ensurePlanIgnored(pi, ctx.cwd);
			const prompt = buildAutopilotPrompt(ctx.cwd, planPath, task, existingPlan);

			if (ctx.hasUI) {
				const label = task
					? `Autopilot queued: ${task}`
					: existingPlan
						? `Autopilot queued: execute ${existingPlan}`
						: "Autopilot queued";
				ctx.ui.notify(label, "info");
			}

			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		},
	});
}
