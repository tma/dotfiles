# Second-opinion operations reference

Use this reference after loading the `second-opinion` skill. Child reviewers are read-only and advisory.

## Relationship to the primary review workflow

The calling review workflow supplies the rubric and output style, plus any required routes, count, focus split, or synthesis it owns; this file owns the operations and follows those requirements.

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
- `opus` — native-first Claude Opus child reviewer; local Claude Code CLI login only if no Pi Opus is accessible (Pi `agent: "opus-review"`)
- `gpt` — dynamically selected strong GPT-family child reviewer (Pi `family: "gpt"`)
- `grok` — dynamically selected strong Grok-family child reviewer (Pi `family: "grok"`)
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

| Current/root model family | Reviewer route | Pi launch |
|---------------------------|----------------|-----------|
| GPT/OpenAI | Claude Opus route | `agent: "opus-review"` |
| Opus/Anthropic | Strong GPT-family route | `agent: "second-opinion"`, `family: "gpt"` |
| Grok/xAI | Claude Opus route | `agent: "opus-review"` |

The Grok route is `agent: "second-opinion"`, `family: "grok"`.

For multiple reviews:

1. If a calling workflow requires specific routes, include each one when available, even if it matches the current/root model family.
2. Otherwise, prefer distinct non-current reviewer routes.
3. If only one non-current route is configured, reuse that route with separate tasks and different reviewer focuses.
4. If the user explicitly requests a current-family reviewer, ask for confirmation unless their wording already makes the override clear.
5. Same-family reviewers are allowed when needed to reach a count the calling workflow requires; label the route/focus clearly.

Suggested focus split when reusing one route:

| Reviewer | Focus |
|----------|-------|
| Reviewer 1 | General correctness, security, and data-loss risks |
| Reviewer 2 | Edge cases, reliability, error handling, and tests |
| Reviewer 3 | Maintainability, performance, operational risks, and design fit |

If the current/root model is unknown and reviewer choice matters, ask:

> Which reviewer route(s) should I use: Claude Opus, GPT, Grok, or mixed?

## Review material

Build a review packet in the root agent before delegating. Use the host harness's normal context-gathering tools; never run external model CLIs yourself. Pi's `opus-review` runner is launched through `subagent`, not a shell.

`opus-review` has no tools and can't read the repository, so its packet must carry everything: the diff, the surrounding file content it needs, instructions, and any command output. `second-opinion` can read local files but has no shell.

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

Include the `code-review` skill's checklist, severity definitions, and output requirements when relevant, plus project-specific review standards. Extract only advisory review guidance. Exclude posting, editing, or PR workflow steps.

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
You are <Reviewer 1|Reviewer 2|Reviewer 3>, an independent second-opinion reviewer running on the configured <Claude Opus|GPT|Grok> family route.
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

The task text names the reviewer label and route on every launch.

- Opus route: `agent: "opus-review"` with no `family`, `model`, or `provider`. The runner selects `auto:strong` with `family: claude-opus` from any available Pi provider, independently of `enabledModels`, and tries matching candidates' authentication. It uses the local Claude Code CLI login only if no matching Pi model is available or all matching candidates return unavailable authentication. `model` and `provider` are rejected, and so is a `family` that Opus doesn't match. It takes `thinking` from `low` to `max`, not `off` or `minimal`; Pi clamps it to the native model's supported levels. Both routes are packet-only with no tools and can't be forked, steered, sent follow-ups, or resumed. Status identifies the chosen route and selection or unavailability reason.
- GPT and Grok routes: `agent: "second-opinion"` with an explicit `family`. Never launch it without `family`: the agent has no family of its own, so the selector could pick any family, including the root agent's own.

Single review:

- Current/root GPT/OpenAI → `agent: "opus-review"`.
- Current/root Opus/Anthropic → `agent: "second-opinion"`, `family: "gpt"`.
- Current/root Grok/xAI → `agent: "opus-review"`.
- Calling workflow with required routes → one task per required route, each with its own route fields.

Multiple reviews:

- Prefer one `subagent` call with `tasks: [...]` for parallel delegation.
- Set each task's `agent` and `task`. Add `family` and, when reviewing a local repository, `cwd` for `second-opinion` tasks.
- Set route fields on each task, not as shared launch defaults: a shared `family` would also reach `opus-review` and fail it.
- If parallel delegation is unavailable, run reviewers sequentially.

Example parallel launch:

```json
{
  "tasks": [
    { "agent": "second-opinion", "family": "gpt", "cwd": "<repo>", "task": "You are Reviewer 1, on the GPT route. ..." },
    { "agent": "opus-review", "task": "You are Reviewer 2, on the Opus route. <full review packet>" }
  ]
}
```

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
| Requested reviewer unavailable | Tell the user what routed child agent is missing; do not run model CLIs yourself |
| `opus-review` fails (native setup/prompt error, fallback CLI missing, not logged in, non-Opus CLI answer, timeout) | Report the Opus route as failed with its error and offer a retry; do not switch to another Opus route unless the user asks. Native runtime or prompt failures after selection never reroute to CLI. Cancellation, selection deadlines, authentication exceptions, and failed catalog refreshes don't trigger CLI fallback either |
| Same-family reviewer requested | Ask for confirmation unless explicitly requested or required by the calling workflow |
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
