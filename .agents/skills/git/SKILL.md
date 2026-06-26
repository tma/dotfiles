---
name: git
description: Use git workflow conventions for commits, pulls, pushes, and branch hygiene.
---

# Git

Use this skill for branch setup, commits, pulls, pushes, history rewriting, and branch cleanup. For command examples and detailed workflows, read `references/workflows.md`.

## Starting development work

Always start a new development task from the latest default branch, not from the current local `HEAD` branch. Treat the checked-out branch as incidental unless the user explicitly asks to continue that branch.

Before creating a task branch or making task-specific edits:

1. Identify the default branch, preferably from `origin/HEAD`.
2. Fetch the latest refs from the remote.
3. Switch to the default branch.
4. Update it from the remote.
5. Create the task branch from that updated default branch.

If the current branch has uncommitted work, do not build new task work on top of it. Stash or commit the work first, or ask the user how to proceed.

## Branch naming

Use a `tma/` prefix for every branch created in a repository whose `origin` is on `github.com` and is not owned by the GitHub user `tma`.

Do **not** require the `tma/` prefix when:

- `origin` is on `github.com` and the owner is `tma`
- `origin` is not on `github.com`

Apply the same rule to worktree branch names.

## Commits

Always group changes into topic-based commits. Each commit should represent one logical change: a feature, bug fix, refactor, or configuration update. Never lump unrelated changes into a single commit.

When multiple files were changed across different topics, review the full diff, identify the topics, and stage each topic separately using `git add <specific files>` or `git add -p`.

When a merge produces conflicts, resolve the conflicts and commit the merge before adding any unrelated changes. Do not fold follow-up fixes, refactors, or new work into the merge commit.

Before writing a commit message on tma's behalf, apply the `writing-voice` skill and its curated profile. Write messages that encode intent and context, not just what changed.

Commit message rules:

- Use imperative mood: `add`, `fix`, `refactor`; not `added` or `fixes`.
- Keep the first line under 72 characters.
- Do not put a period at the end of the summary line.
- Wrap body text at 72 characters.
- Reference issue numbers when applicable.
- Use `git commit -F /tmp/commit-message` for non-trivial messages.

## Pulling

Pull with rebase by default: `git pull --rebase`.

Exception: when a PR is open and not in draft, use a regular merge pull instead. Rebasing would force-push and break review history.

Stash or commit local changes before pulling.

## Amending and rewriting history

Never amend commits or rewrite history when a PR is open for the branch and is not in draft. Add a new commit instead.

Before amending or rebasing, check the current branch PR state with `gh pr view --json state,isDraft` when `gh` is available.

## Pushing

Use `git push -u origin HEAD` for the first push of a new branch. Use `git push --force-with-lease` only after a rebase on a personal branch with no open, non-draft PR.

Never force push to `main` or shared branches. Never force push a branch with an open, non-draft PR.

## Rules

1. **Commit by topic** — one logical change per commit; never mix unrelated changes.
2. **Descriptive messages** — encode intent and context, not just what changed.
3. **Pull with rebase** — use `git pull --rebase` unless an open, non-draft PR makes a merge pull safer.
4. **Commit merges first** — after resolving merge conflicts, commit the merge before adding new changes.
5. **Never force push shared branches** — use `--force-with-lease` on personal branches only.
6. **Never amend or rebase with an open PR** — check `gh pr view` first; add new commits instead.
7. **Stage precisely** — use `git add <files>` or `git add -p`, not `git add .`.
8. **Prefix branches when needed** — use `tma/` for branches on GitHub repositories not owned by `tma`; use the same rule for worktree branch names.
