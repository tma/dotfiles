---
name: second-opinion
description: Get 1–3 independent reviews of changes, PRs, commits, branches, or plans.
---

# Second Opinion

Get one, two, or three independent advisory reviews by delegating self-contained review packets to child/subagents. Default to one review unless the user asks for more.

This skill is harness-agnostic: prepare a review packet, then delegate it through the host harness's native child-agent/subagent mechanism. Do **not** shell out to model CLIs such as Codex, Claude, Gemini, or similar.

## Core Contract

1. Determine review count: `1` by default; infer `2` or `3` when the user asks for multiple opinions. Cap at `3`.
2. Identify the current/root model family when the harness exposes it.
3. Prefer reviewers from a different model family than the current/root agent.
4. Gather the review material and relevant project instructions into a concise review packet.
5. Delegate read-only review tasks to the selected child/subagents.
6. Present each reviewer's findings, then add a brief root-agent synthesis.

For a single review, never choose the same model family as the current/root agent unless the user explicitly confirms that override.

For multiple reviews, use distinct non-current model families when available. If only one non-current routed reviewer exists, you may run multiple independent tasks on that route with different reviewer labels/focuses; say so in the final summary. Use the current/root model family only when the user explicitly requests it, confirms it, or this skill was invoked by a deep/thorough review workflow that needs more reviewer routes.

## Relationship to the Primary Review Workflow

The normal review prompt/workflow is the canonical source for rubric and output style, but not for this skill's operations.

Use the primary review prompt only for:

- Review checklist/rubric: correctness, security, reliability, maintainability, performance, docs, tests.
- Severity buckets and finding format.
- Project-specific review conventions.

Do **not** copy operational workflow steps into the child task, such as:

- Requesting GitHub/Copilot reviews.
- Posting or replying to PR comments.
- Fixing files or applying patches.
- Running full PR triage unless the review packet already contains that context.

The child reviewers are read-only and advisory.

## Harness Adapter

Use the host harness's native child-agent primitive.

### Pi

Use the `subagent` tool with configured reviewer agents:

- `second-opinion-opus` — latest available Opus model.
- `second-opinion-gpt` — latest available GPT model.

For multiple opinions, use `subagent` parallel mode (`tasks`) when possible. Give each task the same core review packet plus its reviewer label and focus.

### Other harnesses

Use the equivalent child-agent/task delegation feature, model override, or named worker agent. The child must receive the same review packet and remain read-only.

If the harness cannot route child agents to the needed reviewer(s), stop and tell the user what routing is missing. Do not substitute an external LLM CLI.

## When to Use

- Getting another opinion on code changes from a child/subagent
- Reviewing branch diffs before opening a PR
- Reviewing a GitHub PR
- Reviewing a plan, design, migration strategy, or implementation proposal
- Checking uncommitted work before committing
- Running focused reviews: security, performance, error handling, tests, maintainability

## When NOT to Use

- The harness cannot launch child/subagent reviewers
- No changes, PR, commit, branch, plan, or input was provided
- The user only wants the current model's own review

## 1. Gather Parameters

Determine scope, count, reviewers, and focus from the user's request. Ask one clarifying question only when required.

**Scope**:

- `input` — pasted plan/text from the user's request
- `plan-file` — a local plan/design file path provided by the user
- `uncommitted` — local uncommitted changes, including relevant untracked files
- `branch` — current branch compared with the default branch
- `commit` — a specific commit
- `pr` — a GitHub PR URL or number

**Count**:

- `1` — default second opinion
- `2` — two other opinions
- `3` — three other opinions

If the user asks for more than three, explain the cap and proceed with three unless they narrow it.

**Reviewer selection**:

- `auto` — prefer model families different from the current/root agent
- `opus` — latest Opus child reviewer
- `gpt` — latest GPT child reviewer
- `mixed` — use multiple routed reviewers when available

**Focus**:

- `general` — full review (default)
- `security` — security-focused
- `performance` — performance-focused
- `errors` — error-handling focus
- `tests` — test coverage and regression-risk focus
- `plan` — plan/design feasibility, risks, sequencing, and missing work

## 2. Choose Reviewer Routes

For a single review, use the opposite family when the current/root family is known:

| Current/root model family | Reviewer route | Pi subagent |
|---------------------------|----------------|-------------|
| GPT/OpenAI | Latest Opus | `second-opinion-opus` |
| Opus/Anthropic | Latest GPT | `second-opinion-gpt` |

For multiple reviews:

1. Prefer distinct non-current reviewer routes.
2. If only one non-current route is configured, reuse that route with separate tasks and different reviewer focuses.
3. If the user explicitly requests a current-family reviewer, ask for confirmation unless their wording already makes the override clear.
4. If invoked by the `code-review` skill for a deep/thorough review, same-family reviewers are allowed when needed to reach the requested count; label the route/focus clearly.

Suggested focus split when reusing one route:

| Reviewer | Focus |
|----------|-------|
| Reviewer 1 | General correctness, security, and data-loss risks |
| Reviewer 2 | Edge cases, reliability, error handling, and tests |
| Reviewer 3 | Maintainability, performance, operational risks, and design fit |

If the current/root model is unknown and reviewer choice matters, ask:

> Which reviewer route(s) should I use: latest Opus, latest GPT, or mixed?

## 3. Gather Review Material

Build a review packet in the root agent before delegating. Use the host harness's normal context-gathering tools; never use external model CLIs.

For code reviews, include the most useful diff/context available:

- Uncommitted changes: current diff plus names/contents of relevant untracked files.
- Branch review: diff from default branch to `HEAD`.
- Commit review: diff for the specified commit.
- PR review: PR diff and important description/context available to the harness.
- Plan/input review: pasted text or plan file contents.

Show the user a short summary before delegation. If the review material is empty, stop. If the diff/input is very large (roughly >2000 lines), warn and ask whether to proceed or narrow scope.

## 4. Add Project Instructions and Rubric

Include relevant project guidance when present:

- `AGENTS.md`
- `CLAUDE.md`
- `.owner/repo`
- `.owner/repo/*.instructions.md` that apply to touched files
- `CONVENTIONS.md`

Also include review rubric/checklist content when available (`.pi/agent/prompts/review.md`, `.pi/prompts/review.md`, or equivalent). Extract only advisory review parts: checklist, severities, output format, and project-specific review standards. Exclude posting, editing, or PR workflow steps.

Do not over-collect. Include enough context for independent reasoning without flooding reviewers with unrelated files.

## 5. Build Child/Subagent Tasks

Each child task must be self-contained and include:

1. Reviewer label (`Reviewer 1`, `Reviewer 2`, `Reviewer 3`).
2. Target model family/route.
3. Scope and focus.
4. Project instructions/checklist.
5. Review material.
6. Output requirements:
   - Organize findings by severity.
   - Include file/line references when possible.
   - Call out uncertainty and assumptions.
   - Do not modify files, post comments, request reviews, or change repository/PR state.
   - Do not delegate recursively.

Template:

```markdown
You are <Reviewer 1|Reviewer 2|Reviewer 3>, an independent second-opinion reviewer running on <latest Opus|latest GPT|configured route>.
The root agent is running on <current model family or unknown>.

Review scope: <scope>
Focus: <general|security|performance|errors|tests|plan|custom>

Project instructions/checklist:
<instructions>

Review material:
<diff, PR, commit, branch, plan, or pasted input>

Return findings in this format:
- 🔴 Must fix — correctness, security, data loss, broken behavior
- 🟡 Should fix — reliability, maintainability, test gaps, risky design
- 💡 Suggestions — smaller improvements and nits
- ✅ What looks good — well-done aspects

Be concise and concrete. Include file/line references where possible. Do not modify files, post comments, request reviews, change repository/PR state, or delegate recursively.
```

For multiple reviewers, keep the shared packet identical and vary only reviewer label, route, and focus.

## 6. Delegate

### Pi

Use the Pi `subagent` tool.

Single review:

- Current/root GPT/OpenAI → `agent: "second-opinion-opus"`.
- Current/root Opus/Anthropic → `agent: "second-opinion-gpt"`.

Multiple reviews:

- Prefer one `subagent` call with `tasks: [...]` for parallel delegation.
- Set each task's `agent`, `task`, and `cwd` when reviewing a local repository.
- If parallel delegation is unavailable, run reviewers sequentially.

### Other harnesses

Use equivalent child-agent invocations with explicit model routes/overrides. Preserve the same task payload and output requirements.

## 7. Present Results

Present each review directly, organized by severity, with clear headers:

```markdown
## Reviewer 1 — Opus Second Opinion
...

## Reviewer 2 — Opus Second Opinion, Reliability Focus
...
```

Then add:

```markdown
## Root-agent synthesis
- Agreements:
- Likely false positives:
- Recommended next step:
```

If multiple tasks reused the same route, mention that plainly.

## Error Handling

| Error | Action |
|-------|--------|
| Current/root model unknown | Ask which route(s) to use if needed |
| Requested reviewer unavailable | Tell the user what routed child agent is missing; do not use model CLIs |
| Same-family reviewer requested | Ask for confirmation unless explicitly requested or invoked by a deep/thorough review workflow |
| Count > 3 | Explain the cap and use three unless narrowed |
| Empty diff/input | Tell user there is nothing to review |
| Review packet too large | Ask the user to narrow scope or confirm proceeding |
| Child/subagent fails | Report the failure and suggest retrying with a narrower packet |

## Examples

```
User: /skill:second-opinion
→ Count: 1
→ Reviewer: opposite family from current/root model
→ Builds a review packet
→ Invokes one child/subagent
→ Presents findings and root-agent synthesis

User: /skill:second-opinion get two other opinions on my branch
→ Count: 2
→ Uses two routed reviewers when available, otherwise two independent tasks on the non-current route
→ Splits focus across general risk and reliability/tests

User: /skill:second-opinion get three opinions on https://github.com/owner/repo/pull/42
→ Count: 3
→ Passes PR diff/context to three read-only reviewer tasks
→ Synthesizes agreements, disagreements, and next steps

User: /skill:second-opinion review this rollout plan: ...
→ Scope: input, Focus: plan
→ Delegates read-only plan review to selected reviewer(s)
```
