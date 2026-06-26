---
name: second-opinion
description: Get 1–3 independent reviews of changes, PRs, commits, branches, or plans.
---

# Second Opinion

Get one, two, or three independent advisory reviews by delegating self-contained review packets to child/subagents. Default to one review unless the user asks for more.

This skill is harness-agnostic: prepare a review packet, then delegate it through the host harness's native child-agent/subagent mechanism. Do **not** shell out to model CLIs such as Codex, Claude, Gemini, or similar.

For routing tables, task templates, examples, and detailed error handling, read `references/operations.md`.

## Core contract

1. Determine review count: `1` by default; infer `2` or `3` when the user asks for multiple opinions. Cap at `3`.
2. Identify the current/root model family when the harness exposes it.
3. Prefer reviewers from a different model family than the current/root agent.
4. Gather the review material and relevant project instructions into a concise review packet.
5. Delegate read-only review tasks to the selected child/subagents.
6. Present each reviewer's findings, then add a brief root-agent synthesis.

For a single review, never choose the same model family as the current/root agent unless the user explicitly confirms that override.

For multiple reviews, use distinct non-current model families when available. If only one non-current routed reviewer exists, you may run multiple independent tasks on that route with different reviewer labels/focuses; say so in the final summary. Use the current/root model family only when the user explicitly requests it, confirms it, or this skill was invoked by a deep/thorough code-review workflow that requires both GPT and Opus routes.

## When to use

- Getting another opinion on code changes from a child/subagent.
- Reviewing branch diffs before opening a PR.
- Reviewing a GitHub PR.
- Reviewing a plan, design, migration strategy, or implementation proposal.
- Checking uncommitted work before committing.
- Running focused reviews: security, performance, error handling, tests, maintainability.

Do not use this skill when the harness cannot launch child/subagent reviewers, when no reviewable input exists, or when the user only wants the current model's own review.

## Pi adapter

Use the `subagent` tool with configured reviewer agents:

- `second-opinion-opus` — latest available Opus model at max thinking (`xhigh`).
- `second-opinion-gpt` — latest available GPT model at max thinking (`xhigh`).

For multiple opinions, use `subagent` parallel mode (`tasks`) when possible. Give each task the same core review packet plus its reviewer label and focus.

## Review packet

Build the review packet in the root agent before delegating. Include only the material needed for an independent read-only review:

- Scope: pasted input, plan file, uncommitted changes, branch diff, commit, or PR.
- Relevant diff or plan content.
- Relevant surrounding file context when needed.
- Project instructions such as `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, or `CONVENTIONS.md` when present.
- Review rubric/checklist content when available.

Show the user a short summary before delegation. If the review material is empty, stop. If the packet is very large, ask whether to proceed or narrow scope.

## Child reviewer constraints

Every child task must say:

- The reviewer is read-only and advisory.
- The reviewer must not modify files, post comments, request reviews, change repository/PR state, or delegate recursively.
- Findings should be organized by severity.
- File/line references should be included when possible.
- Uncertainty and assumptions should be called out.

## Output

Present each review separately, then add a short root-agent synthesis:

- Agreements.
- Likely false positives.
- Recommended next step.

If multiple tasks reused the same route, mention that plainly.

## Rules

1. **Use child/subagent delegation only**; never shell out to external model CLIs.
2. **Default to one review** and cap at three.
3. **Prefer a different model family** from the current/root agent unless the user confirms otherwise.
4. **Keep reviewers read-only**; they do not edit files or post GitHub comments.
5. **Use both GPT and Opus routes** for deep/thorough code-review workflows when available.
6. **Stop on empty input**; do not ask reviewers to review nothing.
