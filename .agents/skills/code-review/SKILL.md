---
name: code-review
description: Review diffs, branches, commits, PRs, Copilot comments, and merge readiness.
---

# Code Review

Use this skill for code reviews of local changes, staged changes, recent commits,
current-branch PRs, or explicit GitHub PR URLs.

Default behavior: review and report findings. Do not post GitHub review comments,
PR comments, issue comments, or review approvals unless the user explicitly asks.
If posting prose on GitHub, load and apply the `writing-voice` skill first.

## Review modes

First determine which mode applies.

Also determine review depth:

- `normal` — default: one primary review by the root agent.
- `deep` — triggered by words like "deep", "thorough", "comprehensive", or
  "extra careful". Run the primary review, then use the `second-opinion` skill
  for multiple read-only reviewers.

For deep reviews, gather the normal review context first, then invoke
`second-opinion` with both latest GPT and latest Opus reviewer routes at max
thinking (`xhigh`). Use two reviewers by default, or three when the user asks for
a very thorough review or explicitly asks for three. Split reviewer focus across:

1. correctness, security, and data-loss risks
2. edge cases, reliability, error handling, and tests
3. maintainability, performance, operational risk, and design fit

Always include both GPT and Opus routes for thorough/deep reviews when available.
Same-family reviewers are OK only when needed to reach the requested count; label
the route/focus clearly. Do not post comments or change repository state unless
the user explicitly asks.

### Mode A — PR URL provided

If the user provided a GitHub PR URL, review that remote PR only. The PR may be
for a different repo than the current directory. Skip local diff gathering.

Use `gh` for GitHub data. Read `references/github-pr-context.md` for the full PR
context workflow.

### Mode B — No PR URL

If no PR URL was provided, review local changes and check whether the current
branch has an open PR.

Prefer review targets in this order:

1. staged diff: `git diff --cached`
2. working tree diff: `git diff`
3. last commit: `git diff HEAD~1`

If a current-branch PR exists, include PR title, body, comments, review comments,
and linked issue context in the review.

## Required context gathering

Before reviewing:

1. Identify the repo, branch, and review mode.
2. Read the full diff, not only the stat.
3. For changed files with large diffs or unclear surrounding context, read the
   full file.
4. If a PR exists, read the PR body, conversation comments, inline review
   comments, and linked issues.
5. If the user asks to process Copilot comments, read
   `references/copilot-review.md` and follow that workflow.

Do not review from a summary alone when source files are available.

## Review checklist

Read `references/checklist.md` and apply it to each changed file. Focus on real
issues that matter for the codebase:

- correctness
- security
- reliability
- maintainability
- performance, only when clearly relevant
- docs
- tests

Do not invent problems. If the diff is clean, say so.

## Output format

Organize findings by severity:

### 🔴 Must fix

Issues that will cause bugs, security vulnerabilities, or data loss.

### 🟡 Should fix

Issues that hurt reliability, readability, or maintainability.

### 💡 Suggestions

Optional improvements: style nits, minor simplifications, better naming.

### ✅ What looks good

Briefly note what is well done: good tests, clear error handling, clean naming,
or a simple design.

### 🤖 Copilot comments addressed

If a Copilot review was processed, summarize how many comments were addressed,
which were fixed, which were dismissed, and why.

### 📋 PR context

If a PR exists, note whether the changes address PR feedback and linked issue
requirements. Flag any PR comments or issue requirements not yet addressed.

### 📝 Docs

Say whether docs need updates. If the changes introduce new features, config, or
behavior changes without docs, flag that specifically.

### 🧪 Tests

Summarize test coverage. List specific code paths or files that need tests but
do not have them.

For each finding:

- quote the relevant code or cite file + line range
- explain what goes wrong concretely
- suggest a fix when possible

## Publishing reviews or comments

If the user asks you to post comments or a GitHub review:

1. Draft the review text first.
2. Load and apply the `writing-voice` skill and curated profile.
3. Ask for confirmation before publishing unless the user explicitly asked you to
   post/publish/submit.
4. Use `gh`, preferably with `--body-file` for anything longer than one sentence.

Never post `@copilot review this`; request Copilot through the reviewer flow in
`references/copilot-review.md`.
