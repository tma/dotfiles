---
name: github
description: Use gh for GitHub issues, PRs, reviews, Copilot reviewer requests, Actions, Codespaces, and code search.
---

# GitHub

Use the `gh` CLI for all GitHub operations. Never use `curl` with raw API URLs or the `octokit` library; `gh` handles authentication, pagination, and API versioning.

For command examples, read the [GitHub command reference](./references/command-reference.md). For broad code searches and full-link requirements, read the [code search workflow](./workflows/code-search.md).

## Writing on GitHub

Before creating or updating GitHub prose on tma's behalf, load and apply the `writing-voice` skill and its curated profile.

This includes:

- PR titles
- PR bodies
- issue bodies
- PR comments
- issue comments
- PR review comments
- release notes

Draft the text first, apply the writing-voice checklist, then publish with `gh`. Prefer `--body-file` over inline `--body` for anything longer than one sentence.

Every PR title and description must lead with **why the PR exists**:

- Start the title with the intended outcome, problem being solved, or risk being avoided. Name the mechanism second when useful.
- Answer why this change is worth making before describing what changed.
- Include the user or repository impact and why the current behavior is insufficient.
- Do not open with a change list, implementation summary, or test plan.
- Before drafting a body, check for a repository PR template locally or through `gh`. Preserve its required headings, checklists, and ordering.
- Without a fixed repository template, `## Why` must be the first substantive heading. Put `## Change`, screenshots, and verification after it.
- When a repository template fixes the heading order, make the first substantive prose explain why before how.

For GitHub-facing Markdown (issues, PRs, discussions, comments, and reviews), let GitHub autolink issue and PR references. Do not wrap GitHub issue or PR cross-references in backticks; it prevents auto-linking. Do not turn full GitHub issue or PR URLs into Markdown links like `[owner/repo#123](https://github.com/owner/repo/issues/123)`. Use the bare URL instead, especially in bullet lists.

## Authentication

Already configured. Use `gh auth status` to verify. Do not ask for tokens.

## Repository access

Use `gh` with the repository and owner provided by the user or detected from the current repository. Do not assume access to private repositories, organization repositories, runbooks, or service-specific documentation unless the user provides that context.

Use `--repo owner/repo` when not in the target repository's directory.

## Starting development work

When a GitHub issue, PR follow-up, or other development task requires local code changes, load and apply the `git` skill. Start from the latest default branch and use the branch naming rules from that skill.

Do not base new task work on the currently checked-out local branch unless the user explicitly asks to continue it.

## Copilot PR reviews

When the user asks for a GitHub Copilot review on a PR, use the requested-reviewer flow. Add `copilot-pull-request-reviewer[bot]` as a reviewer/requested reviewer.

Never post `@copilot review this`; that does not create the requested-reviewer review flow. Use the [GitHub command reference](./references/command-reference.md) for the exact commands.

## Rules

1. **Always use `gh` CLI** — never `curl`, `fetch`, or direct HTTP to `api.github.com`.
2. **Use `--repo owner/repo`** when not in the target repository's directory.
3. **Use `--json` + `--jq`** for structured output; do not parse human-readable text.
4. **Use `gh api`** for endpoints without a dedicated subcommand.
5. **Paginate with `--paginate`** when listing; default page size is 30.
6. **Do not create tokens**; `gh` manages authentication.
7. **Never use web_search or web_read** for GitHub data; use `gh` for issues, PRs, code search, Actions, and API data.
8. **Use requested reviewers for review requests**; when the user asks for a GitHub Copilot review, add `copilot-pull-request-reviewer[bot]` as a reviewer/requested reviewer.
9. **Lead PR titles and descriptions with why** — explain the motivation and intended impact before what changed or how it works.
