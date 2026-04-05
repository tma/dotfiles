/**
 * /plan command — Create structured implementation plans at the current worktree's .pi/plan.md.
 *
 * With args:  /plan <task> — analyze codebase and plan for the task
 * Without:    /plan — formalize the plan discussed in conversation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function findGitRoot(from: string): string | null {
	let dir = from;
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function findPlanFile(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi", "plan.md");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function getPlanPath(cwd: string): string {
	const root = findGitRoot(cwd) || cwd;
	return path.join(root, ".pi", "plan.md");
}

export const PLAN_FORMAT = `\`\`\`markdown
# Plan: <descriptive title>

## Context
What exists now. Stack, architecture, relevant patterns found in the codebase.
Include specific file paths and current behavior.

## Goal
What we're trying to achieve and why.

## Considerations
- Design decisions made and why
- Alternative approaches considered and rejected
- Risks, edge cases, backward compatibility
- Assumptions

## Tasks

### 1. <task title>
- **Agent**: coder | scout | researcher
- **Files**: list of files to create or modify
- **Depends on**: none | task N
- **Description**: Detailed, self-contained description with enough context
  to implement without seeing any conversation. Include function names,
  patterns to follow from the codebase, test expectations, verification steps.

### 2. <task title>
...

## Execution Strategy
- **Parallel group 1**: tasks 1, 2 (independent)
- **Then**: task 3 (depends on 1, 2)
- **Parallel group 2**: tasks 4, 5 (depend on 3)
\`\`\``;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("plan", {
		description: "Create an implementation plan: /plan [task] — writes worktree-local .pi/plan.md",
		handler: async (args, ctx) => {
			const planPath = getPlanPath(ctx.cwd);
			const task = args?.trim();

			const existingPlan = findPlanFile(ctx.cwd);
			const existingNote = existingPlan
				? `\n\nNote: An existing plan exists at ${existingPlan}. Overwrite it with the new plan.`
				: "";

			const planPrompt = task
				? `Analyze the codebase and create a structured implementation plan for this task. Write the plan to ${planPath}.

## Instructions
1. First, explore the codebase to understand the architecture, patterns, and relevant code (use read, grep, find, ls directly — do NOT delegate this).
2. Then write the plan file to ${planPath} using the exact format below.
3. The plan must be detailed enough that any agent can execute a task from it without additional context.
4. Record all considerations, trade-offs, and rejected alternatives — the plan is documentation.${existingNote}

## Plan format
${PLAN_FORMAT}

## Task
${task}`
				: `Formalize the plan we've been discussing into a structured plan file. Write it to ${planPath}.

## Instructions
1. Review our conversation and extract the plan we've been working on.
2. If needed, explore the codebase for additional context (file paths, patterns, current behavior).
3. Write the plan file to ${planPath} capturing ALL intentions, considerations, and decisions from our discussion.
4. Each task must be self-contained — an agent should be able to implement it from the plan alone.${existingNote}

## Plan format
${PLAN_FORMAT}

Do NOT summarize the conversation. Write the plan file now.`;

			pi.sendUserMessage(planPrompt, { deliverAs: "followUp" });
		},
	});
}
