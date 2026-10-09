---
name: code-review
description: Review local changes, a commit, a branch, or a GitHub PR for requirements coverage, code quality, and merge readiness. Use when the user asks for a review, a deep or thorough review, merge readiness, or to process Copilot review comments on a PR.
---

# Code Review

Use this skill when the user asks for a review of staged or working-tree changes,
a recent commit, the current branch's PR, or a GitHub PR URL.

**Do not post anything by default.** Review and report. No GitHub review comments,
PR comments, issue comments, or approvals unless the user explicitly asks. When
the user does ask, follow [Publishing reviews or comments](#publishing-reviews-or-comments).

## 1. Pick the mode

**Mode A — a PR URL was provided.** Review that remote PR only. It may belong to a
different repository than the current directory, so skip local diff gathering. Use
`gh` for all GitHub data; read the
[GitHub PR context workflow](./references/github-pr-context.md).

**Mode B — no PR URL.** Review local changes and check whether the current branch
has an open PR. Pick the first target that is non-empty:

1. staged diff: `git diff --cached`
2. working tree diff: `git diff`
3. last commit: `git diff HEAD~1`

Say which target you reviewed. If a current-branch PR exists, include it and its
linked issues as context.

## 2. Gather the full context

1. Identify the repository, branch, and review target.
2. Read the full diff, not only the statistics.
3. Read the complete file for any change with a large diff or unclear surrounding
   context.
4. When a PR exists, read its body, conversation comments, inline review comments,
   and every issue it references. Look for closing keywords, `#123`,
   `owner/repo#123`, and full issue URLs in the body, and read each referenced
   issue with its comments. These usually hold the motivation, data, constraints,
   and acceptance criteria the diff has to satisfy.
5. If the user asks to process Copilot comments, read the
   [Copilot review workflow](./references/copilot-review.md).

Never review from a summary when the source files are available.

## 3. Check requirements coverage

Requirements and code quality are separate judgments. Good code that implements
the wrong thing passes one and fails the other, so report them separately.

First establish what was asked for. The user's instructions in this conversation
set the scope; the written sources fill in the detail:

1. The scope, constraints, and clarifications the user gave you directly.
2. The linked issue or issues, including their comments.
3. The PR body's stated intent and acceptance criteria.
4. A specification or design document the user pointed at.

Historical text is context, not automatically binding. An issue written months ago
may describe a requirement that was later dropped, narrowed, or superseded by what
the user just told you. When a written source conflicts with the user's stated
scope, or two sources conflict with each other, report the conflict and which one
you reviewed against. Do not grade the diff against a requirement the user has
already ruled out, and do not silently drop one they never mentioned.

If none of these exist, say "no stated requirements found" and review quality
only. That is a normal outcome, not a blocker, and never a reason to invent a
specification and grade the diff against it.

When requirements do exist, sort every one of them into:

- **Met** — implemented, with the file or symbol that does it.
- **Partial** — started or handled for some cases. Say which cases are missing.
- **Missing** — not addressed at all.
- **Unsupported assumption** — the diff assumes something the requirements never
  state: a default value, an input shape, an ordering, a permission, a migration
  already having run. Name the assumption and what breaks if it is wrong.

Then check the other direction: **unrequested scope.** Changes in the diff that no
requirement asked for. Renames, refactors, dependency bumps, new configuration,
behavior changes to untouched areas. Some are fine; say what you found and let the
user decide whether it belongs in this change.

## 4. Review quality

Read the [review checklist](./references/checklist.md) and apply it to each changed
file: correctness, security, reliability, maintainability, performance where it is
clearly relevant, documentation, and tests.

These are repository standards, not requirements. Keep them out of the
requirements section even when they are the more serious finding.

Do not invent problems. If the diff is clean, say so.

## 5. Choose the depth

**Normal** is the default: one review by this agent, whatever the size of the diff.

**Deep** applies when the user says "deep", "thorough", "comprehensive", or "extra
careful", or asks for more than one reviewer. Run the normal review yourself
first, then delegate to the `second-opinion` skill, which owns the reviewer
contract and launch mechanics. Deep code review requires both the latest GPT and
the latest Opus routes at max thinking; read the
[deep review reference](./references/deep-review.md) before delegating.

An explicit request for a deep or multi-reviewer review is honored as asked. Do
not downgrade it because the diff looks small. If the required routes are
unavailable, say which ones and what you ran instead.

## 6. Report

Organize findings by severity. Include only the sections that have something to say.

### 🔴 Must fix

Issues that will cause bugs, security vulnerabilities, or data loss.

### 🟡 Should fix

Issues that hurt reliability, readability, or maintainability.

### 💡 Suggestions

Optional improvements: style nits, minor simplifications, better naming.

### ✅ What looks good

Briefly note what is well done: good tests, clear error handling, clean naming,
or a simple design.

### 📋 Requirements coverage

Met, partial, missing, and unsupported assumptions, each tied to the requirement
it comes from. List unrequested scope here too. If no requirements were found, say
so in one line.

### 🤖 Copilot comments addressed

If a Copilot review was processed, summarize how many comments were addressed,
which were fixed, which were dismissed, and why.

### 📝 Docs

Say whether documentation needs updates. Flag new features, configuration, or
behavior changes that ship without documentation.

### 🧪 Tests

Summarize test coverage. Name the specific code paths or files that need tests and
do not have them.

For each finding: quote the code or cite file plus line range, explain concretely
what goes wrong, and suggest a fix when you can.

## Publishing reviews or comments

If the user asks you to post comments or a GitHub review:

1. Draft the review text first.
2. Load and apply the `writing-voice` skill and its curated profile.
3. Ask for confirmation before publishing unless the user already explicitly asked
   you to post, publish, or submit.
4. Publish with `gh`, using `--body-file` for anything longer than one sentence.

Never post `@copilot review this`. Request Copilot through the
[Copilot review workflow](./references/copilot-review.md).

---

Requirements-review guidance is adapted from Matt Pocock's `code-review` skill. See [third-party notices](../THIRD_PARTY_NOTICES.md).
