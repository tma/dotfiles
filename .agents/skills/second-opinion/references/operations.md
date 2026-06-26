# Second-opinion operations reference

Use this reference after loading the `second-opinion` skill. Child reviewers are read-only and advisory.

## Relationship to the primary review workflow

The normal review prompt/workflow is the canonical source for rubric and output style, but not for this skill's operations.

Use the primary review prompt only for:

- Review checklist/rubric: correctness, security, reliability, maintainability, performance, documentation, tests.
- Severity buckets and finding format.
- Project-specific review conventions.

Do **not** copy operational workflow steps into the child task, such as:

- Requesting GitHub or Copilot reviews.
- Posting or replying to PR comments.
- Fixing files or applying patches.
- Running full PR triage unless the review packet already contains that context.

## Scope, count, route, and focus

Scope:

- `input` — pasted plan/text from the user's request
- `plan-file` — a local plan/design file path provided by the user
- `uncommitted` — local uncommitted changes, including relevant untracked files
- `branch` — current branch compared with the default branch
- `commit` — a specific commit
- `pr` — a GitHub PR URL or number

Count:

- `1` — default second opinion
- `2` — two other opinions
- `3` — three other opinions

If the user asks for more than three, explain the cap and proceed with three unless they narrow it.

Reviewer selection:

- `auto` — prefer model families different from the current/root agent
- `opus` — latest Opus child reviewer at max thinking (`xhigh`)
- `gpt` — latest GPT child reviewer at max thinking (`xhigh`)
- `mixed` — use multiple routed reviewers when available

Focus:

- `general` — full review (default)
- `security` — security-focused
- `performance` — performance-focused
- `errors` — error-handling focus
- `tests` — test coverage and regression-risk focus
- `plan` — plan/design feasibility, risks, sequencing, and missing work

## Reviewer route selection

For a single review, use the opposite family when the current/root family is known:

| Current/root model family | Reviewer route | Pi subagent |
|---------------------------|----------------|-------------|
| GPT/OpenAI | Latest Opus | `second-opinion-opus` |
| Opus/Anthropic | Latest GPT | `second-opinion-gpt` |

For multiple reviews:

1. If invoked by the `code-review` skill for a deep/thorough review, always include both `second-opinion-gpt` and `second-opinion-opus` when available, even if one matches the current/root model family.
2. Otherwise, prefer distinct non-current reviewer routes.
3. If only one non-current route is configured, reuse that route with separate tasks and different reviewer focuses.
4. If the user explicitly requests a current-family reviewer, ask for confirmation unless their wording already makes the override clear.
5. Same-family reviewers are allowed when needed to reach the requested count for deep/thorough reviews; label the route/focus clearly.

Suggested focus split when reusing one route:

| Reviewer | Focus |
|----------|-------|
| Reviewer 1 | General correctness, security, and data-loss risks |
| Reviewer 2 | Edge cases, reliability, error handling, and tests |
| Reviewer 3 | Maintainability, performance, operational risks, and design fit |

If the current/root model is unknown and reviewer choice matters, ask:

> Which reviewer route(s) should I use: latest Opus, latest GPT, or mixed?

## Review material

Build a review packet in the root agent before delegating. Use the host harness's normal context-gathering tools; never use external model CLIs.

For code reviews, include the most useful diff/context available:

- Uncommitted changes: current diff plus names/contents of relevant untracked files.
- Branch review: diff from default branch to `HEAD`.
- Commit review: diff for the specified commit.
- PR review: PR diff and important description/context available to the harness.
- Plan/input review: pasted text or plan file contents.

Show the user a short summary before delegation. If the review material is empty, stop. If the diff/input is very large, roughly more than 2000 lines, warn and ask whether to proceed or narrow scope.

## Project instructions and rubric

Include relevant project guidance when present:

- `AGENTS.md`
- `CLAUDE.md`
- `.github/copilot-instructions.md`
- `.github/instructions/*.instructions.md` that apply to touched files
- `CONVENTIONS.md`

Also include review rubric/checklist content when available, such as `.pi/agent/prompts/review.md`, `.pi/prompts/review.md`, or equivalent. Extract only advisory review parts: checklist, severities, output format, and project-specific review standards. Exclude posting, editing, or PR workflow steps.

Do not over-collect. Include enough context for independent reasoning without flooding reviewers with unrelated files.

## Child/subagent task template

Each child task must be self-contained and include:

1. Reviewer label: `Reviewer 1`, `Reviewer 2`, or `Reviewer 3`.
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
You are <Reviewer 1|Reviewer 2|Reviewer 3>, an independent second-opinion reviewer running on <latest Opus|latest GPT|configured route> at max thinking when supported.
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

## Delegation

### Pi

Use the Pi `subagent` tool.

Single review:

- Current/root GPT/OpenAI → `agent: "second-opinion-opus"`.
- Current/root Opus/Anthropic → `agent: "second-opinion-gpt"`.
- Deep/thorough code-review workflow → include both `agent: "second-opinion-gpt"` and `agent: "second-opinion-opus"`.

Multiple reviews:

- Prefer one `subagent` call with `tasks: [...]` for parallel delegation.
- Set each task's `agent`, `task`, and `cwd` when reviewing a local repository.
- If parallel delegation is unavailable, run reviewers sequentially.

### Other harnesses

Use equivalent child-agent invocations with explicit model routes/overrides. Preserve the same task payload and output requirements.

## Presenting results

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

## Error handling

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

```text
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
