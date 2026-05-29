---
name: second-opinion
description: Get 1–3 independent reviews of changes, PRs, commits, branches, or plans.
---

# Second Opinion

Get an independent review from a different model family by delegating to a child/subagent and passing it the relevant review context.

This skill is intentionally harness-agnostic: the core behavior is "prepare a review packet, then delegate that packet to a child agent running the opposite model family." Do **not** shell out to model CLIs such as Codex, Claude, Gemini, or similar. Use only the host harness's native child-agent/subagent mechanism.

## Core Contract

1. Identify the current/root agent's model family.
2. Choose one child reviewer from the other family:
   - Current model is GPT/OpenAI (`gpt-*`, `openai/*`, `github-copilot/gpt-*`, or similar) → choose the latest Opus reviewer.
   - Current model is Opus/Anthropic (`opus`, `claude-opus-*`, `anthropic/*opus*`, `github-copilot/claude-opus-*`, or similar) → choose the latest GPT reviewer.
3. Gather the review material and any project instructions into a concise review packet.
4. Delegate exactly one review task to the chosen child/subagent, explicitly naming the target model family and including the review packet.
5. Present the child/subagent's findings, then add the root agent's brief agreement/disagreement notes.

Never choose the same model family as the current/root agent for the second opinion unless the user explicitly confirms that override.

## Relationship to the Primary Review Workflow

The normal review prompt/workflow is the canonical source for the review rubric and output style, but it is not the workflow for this skill.

Use the primary review prompt only for:

- Review checklist/rubric: correctness, security, reliability, maintainability, performance, docs, tests.
- Severity buckets and finding format.
- Project-specific review conventions.

Do **not** copy or execute operational parts of the primary review workflow inside the second-opinion child, such as:

- Requesting GitHub/Copilot reviews.
- Posting or replying to PR comments.
- Fixing files or applying patches.
- Running a full PR triage workflow unless the review packet already contains that context.

The second-opinion child is read-only and advisory. After it returns findings, the root agent/user can decide whether to act on them.

## Harness Adapter

Use the host harness's native child-agent primitive:

- **Pi**: use the `subagent` tool with one of the configured reviewer agents:
  - `second-opinion-opus` — pinned to the latest available Opus model.
  - `second-opinion-gpt` — pinned to the latest available GPT model.
- **Other harnesses**: use the equivalent child-agent/task delegation feature, model override, or named worker agent. The child must run the target opposite model family and receive the same review packet.

If the harness cannot route a child agent to a specific model family, stop and tell the user what routing is missing. Do not substitute an external LLM CLI.

## When to Use

- Getting a second opinion on code changes from a different model family
- Reviewing branch diffs before opening a PR
- Reviewing a GitHub PR
- Reviewing a plan, design, migration strategy, or implementation proposal
- Checking uncommitted work before committing
- Running a focused review (security, performance, error handling)

## When NOT to Use

- The harness cannot launch a child/subagent on the opposite model family
- No changes, PR, commit, branch, plan, or input was provided
- You want the current model's own review only — use the normal review flow instead

## 1. Gather Parameters

Determine scope, reviewer, and focus from the user's request. If the reviewer cannot be inferred from the current model, ask one clarifying question.

**Scope** (what to review):
- `input` — pasted plan/text from the user's request
- `plan-file` — a local plan/design file path provided by the user
- `uncommitted` — local uncommitted changes, including relevant untracked files
- `branch` — current branch compared with the default branch
- `commit` — a specific commit
- `pr` — a GitHub PR URL or number

**Reviewer**:
- `auto` — choose opposite family from the current/root agent model (default)
- `opus` — latest Opus child reviewer; only valid when current/root model is not Opus
- `gpt` — latest GPT child reviewer; only valid when current/root model is not GPT

**Focus** (optional):
- `general` — full review (default)
- `security` — security-focused
- `performance` — performance-focused
- `errors` — error handling focus
- `plan` — plan/design feasibility, risks, sequencing, and missing work

## 2. Choose the Opposite Reviewer

Use this decision table:

| Current/root model family | Child reviewer | Pi subagent name |
|---------------------------|----------------|------------------|
| GPT/OpenAI | Latest Opus | `second-opinion-opus` |
| Opus/Anthropic | Latest GPT | `second-opinion-gpt` |

If the current/root model is neither GPT nor Opus, or if the model is not visible in the harness context, ask:

> Which reviewer should I use for the second opinion: latest Opus or latest GPT?

If the user explicitly asks for a reviewer that matches the current/root model family, explain that this skill is intended to use a different family and ask for confirmation before proceeding.

## 3. Gather Review Material

Build a review packet in the root agent before delegating. Use the host harness's normal context-gathering tools (for example, file readers, built-in diff/Git support, or repository context supplied by the user), but never external model CLIs.

For code reviews, include the most useful diff/context available:

- Uncommitted changes: current diff plus names/contents of relevant untracked files.
- Branch review: diff from default branch to `HEAD`.
- Commit review: diff for the specified commit.
- PR review: PR diff and any important description/context available to the harness.
- Plan/input review: the pasted text or plan file contents.

Show the user a short summary before delegation. If the review material is empty, stop. If the diff/input is very large (roughly >2000 lines), warn and ask whether to proceed or narrow scope.

## 4. Add Project Instructions and Rubric

Include relevant project guidance in the review packet when present:

- `AGENTS.md`
- `CLAUDE.md`
- `.owner/repo`
- `.owner/repo/*.instructions.md` that apply to touched files
- `CONVENTIONS.md`

Also include the review rubric from the project's primary review prompt/checklist if available (`.pi/agent/prompts/review.md`, `.pi/prompts/review.md`, or equivalent). Extract only the advisory review parts: checklist, severity definitions, output format, and project-specific review standards. Exclude action-oriented workflow steps such as requesting Copilot reviews, posting comments, editing files, or otherwise changing repository/PR state.

Do not over-collect. Include enough context for the child reviewer to reason independently without flooding it with unrelated files.

## 5. Build the Child/Subagent Task

The task sent to the child/subagent must be self-contained and include:

1. The selected target model family (`latest Opus` or `latest GPT`).
2. Scope and focus.
3. Project instructions/checklist.
4. The review material (diff, PR, commit, branch, plan, or pasted input).
5. Output requirements:
   - Organize findings by severity.
   - Include file/line references when possible.
   - Call out uncertainty and assumptions.
   - Do not modify files, post comments, request reviews, or change repository/PR state.
   - Do not delegate recursively.

Template:

```markdown
You are the independent second-opinion reviewer running on <latest Opus|latest GPT>.
The root agent is running on <current model family>, so you are intentionally the opposite model family.

Review scope: <scope>
Focus: <general|security|performance|errors|plan>

Project instructions/checklist:
<instructions>

Review material:
<diff, PR, commit, branch, plan, or pasted input>

Return findings in this format:
- 🔴 Must fix — correctness, security, data loss, broken behavior
- 🟡 Should fix — reliability, maintainability, test gaps, risky design
- 💡 Suggestions — smaller improvements and nits
- ✅ What looks good — well-done aspects

Be concise and concrete. Include file/line references where possible. Do not modify files, post comments, request reviews, or change repository/PR state.
```

## 6. Delegate

### Pi

Use the Pi `subagent` tool:

- If current/root model is GPT/OpenAI, call `subagent` with `agent: "second-opinion-opus"`.
- If current/root model is Opus/Anthropic, call `subagent` with `agent: "second-opinion-gpt"`.

Pass the full child task as the `task` argument. Set `cwd` when the review refers to a local repository.

### Other Harnesses

Use the equivalent child-agent invocation with an explicit model route/override to the chosen opposite family. Preserve the same task payload and output requirements.

## 7. Present Results

Present the child/subagent review directly, organized by severity:

- 🔴 **Must fix** — bugs, security issues, data loss
- 🟡 **Should fix** — reliability, readability, maintainability
- 💡 **Suggestions** — style nits, minor improvements
- ✅ **What looks good** — well-done aspects

Use a clear header naming the reviewer/model family:

```markdown
## Opus Second Opinion
...
```

or

```markdown
## GPT Second Opinion
...
```

After the child review, add a brief **Root-agent take** section noting which findings you agree with, which may be false positives, and any recommended next step.

## Error Handling

| Error | Action |
|-------|--------|
| Current/root model unknown | Ask whether to use latest Opus or latest GPT |
| Opposite-family child agent unavailable | Tell the user the harness lacks the required routed child agent; do not use model CLIs |
| Same-family reviewer requested | Explain the mismatch and ask for confirmation before proceeding |
| Empty diff/input | Tell user there is nothing to review |
| Review packet too large | Ask the user to narrow scope or confirm proceeding |
| Child/subagent fails | Report the failure and suggest retrying with a narrower packet |

## Examples

```
User: /skill:second-opinion
→ Determines current/root model family
→ GPT current: delegates to latest Opus child reviewer
→ Opus current: delegates to latest GPT child reviewer
→ Asks scope/focus if missing
→ Builds a review packet
→ Invokes one child/subagent with that packet
→ Presents findings and root-agent take

User: /skill:second-opinion check my branch for security issues
→ Scope: branch, Focus: security
→ Reviewer: opposite family from current/root model
→ Delegates to the appropriate child/subagent

User: /skill:second-opinion https://github.com/org/repo/pull/42
→ Scope: PR URL
→ Reviewer: opposite family from current/root model
→ Passes the PR diff/context to the child/subagent

User: /skill:second-opinion review this rollout plan: ...
→ Scope: input, Focus: plan
→ Reviewer: opposite family from current/root model
→ Passes the plan text to the child/subagent
```
