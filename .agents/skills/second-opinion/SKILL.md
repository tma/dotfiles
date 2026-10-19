---
name: second-opinion
description: Get 1-3 independent read-only reviews of changes, PRs, commits, branches, or plans from other model families. Use when the user asks for a second opinion or multiple opinions, or when a deep code review needs cross-family reviewers.
---

# Second Opinion

Get one, two, or three independent advisory reviews by delegating self-contained review packets to child/subagents. Default to one review; follow a calling workflow's required count or an explicit request for more, up to three.

This skill is harness-agnostic: prepare a review packet, then delegate it through the host harness's native child-agent/subagent mechanism. Do **not** shell out to model CLIs such as Codex, Claude, Gemini, or similar. Pi's `opus-review` agent uses native Pi Opus first; its built-in runner uses Claude Code CLI only when no Pi Opus model is accessible. Launch it through the `subagent` tool like any other child. Never run `claude` or another model CLI yourself.

This skill owns the child-reviewer contract, launch mechanics, default routing, and reviewer error handling. A calling workflow may impose its own route, count, focus, or synthesis requirements; follow them within the three-reviewer cap and the read-only contract.

For routing tables, task templates, examples, and detailed error handling, read the [operations reference](./references/operations.md).

## Core contract

1. Determine review count: `1` by default, or the count a calling workflow requires; infer `2` or `3` when the user asks for multiple opinions. Cap at `3`.
2. Identify the current/root model family when the harness exposes it.
3. Prefer reviewers from a different model family than the current/root agent.
4. Gather the review material and relevant project instructions into a concise review packet.
5. Delegate read-only review tasks to the selected child/subagents.
6. Present each reviewer's findings, then add a brief root-agent synthesis.

For a single review, never choose the same model family as the current/root agent unless the user explicitly confirms that override.

For multiple reviews, use distinct non-current model families when available. If only one non-current routed reviewer exists, you may run multiple independent tasks on that route with different reviewer labels/focuses; say so in the final summary. Use the current/root model family only when the user explicitly requests it, confirms it, or a calling workflow requires that route.

## When to use

- Getting another opinion on code changes from a child/subagent.
- Reviewing branch diffs before opening a PR.
- Reviewing a GitHub PR.
- Reviewing a plan, design, migration strategy, or implementation proposal.
- Checking uncommitted work before committing.
- Running focused reviews: security, performance, error handling, tests, maintainability.

Do not use this skill when the harness cannot launch child/subagent reviewers, when no reviewable input exists, or when the user only wants the current model's own review.

## Pi adapter

Use the `subagent` tool. Both reviewer agents default to `high` thinking; pass `thinking: "max"` when a calling workflow, such as deep code review, requires maximum thinking. Pick the agent by route:

- Claude Opus route — `agent: "opus-review"`, with no `family`, `model`, or `provider`. It selects authenticated Opus from any Pi provider first, using the local Claude Code CLI login only if none is accessible. Both routes have no tools, so the task must carry the whole packet: diff, file context, instructions, and command output. Status identifies the chosen route and selection or unavailability reason.
- GPT route — `agent: "second-opinion"`, `family: "gpt"`.
- Grok route — `agent: "second-opinion"`, `family: "grok"`.

Never launch `second-opinion` without `family`. The agent has no family of its own, so the selector could pick any family, including the root agent's own.

Launch every reviewer with fresh context (the default); `opus-review` rejects `context: "fork"`. If `opus-review` fails, report the Opus route as failed and offer a retry. Errors after native selection don't reroute to CLI; cancellation, deadlines, and authentication exceptions don't trigger fallback either. Don't replace it with `second-opinion` on `family: "claude-opus"` unless the user asks for that.

For multiple opinions, use `subagent` parallel mode (`tasks`) when possible. Give each task the same core review packet plus its own `agent` and, for `second-opinion`, its own `family`. Put each reviewer's label, route, and focus in the task text.

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

## Outcomes

Say which of these happened; do not present a partial run as a full one.

- **Reviews delivered** — each reviewer's findings, its route and focus, then the synthesis. Mention when tasks reused one route.
- **Partial** — one reviewer failed or timed out. Present what came back, name what is missing, and offer a retry with a narrower packet.
- **Not run** — no reviewable input, no routed reviewer agent available, or the harness cannot launch child agents. Say which, and do not substitute your own review while calling it a second opinion.
- **Waiting on the user** — the packet is very large or a same-family reviewer needs confirmation.
