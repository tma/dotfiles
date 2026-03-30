---
name: git
description: Git workflow conventions — commit organization, message style, pull strategy, and branch hygiene. Use when committing, pulling, pushing, or managing git history.
---

# Git

## Commits

### Commit by topic

Always group changes into **topic-based commits**. Each commit should represent one logical change — a feature, bugfix, refactor, or config update. Never lump unrelated changes into a single commit.

When multiple files were changed across different topics:

1. Review all changes with `git diff` and `git status`
2. Identify distinct topics (e.g., "new extension", "bug fix in X", "config change")
3. Stage and commit each topic separately using `git add <specific files>`
4. Order commits logically — foundations first, dependents after

```bash
# Stage specific files for one topic
git add path/to/related-file-1 path/to/related-file-2
git commit -m "descriptive message"

# Then the next topic
git add path/to/other-file
git commit -m "descriptive message"
```

Use `git add -p` when a single file contains changes belonging to different topics.

### Commit messages

Write messages that encode **intent and context**, not just what changed. Someone reading the log should understand *why* without opening the diff.

**Format:**
```
<concise summary of what and why>

Optional body for complex changes:
- Additional context
- Trade-offs or alternatives considered
- Related issues or links
```

**Good:**
```
add PID scoping to status files to prevent multi-session collisions

Multiple pi sessions in the same directory were overwriting each
other's stats and todos files. Scope filenames by process.pid and
pass PI_PID env var to the status panel shell script.
```

**Bad:**
```
update files
fix bug
changes
WIP
```

**Rules:**
- Use imperative mood: "add", "fix", "refactor" — not "added", "fixes"
- First line under 72 characters
- No period at the end of the summary line
- Body wrapped at 72 characters
- Reference issue numbers when applicable

## Pulling

### Always rebase by default

```bash
git pull --rebase
```

This keeps history linear and avoids unnecessary merge commits.

**Exception — open (non-draft) PRs:** When a PR is open and not in draft, others may have already reviewed the commits. Rebasing would force-push and break the review history. In that case, use a regular merge pull:

```bash
git pull  # merge, no rebase
```

Configure rebase as default:
```bash
git config --global pull.rebase true
```

### Before pulling

```bash
# Stash or commit local changes first
git stash  # or commit
git pull --rebase
git stash pop  # if stashed
```

## Amending and rewriting history

**Never amend commits or rewrite history when a PR is open for the branch.** Amending + force-pushing destroys review context — comments become orphaned and reviewers lose track of what changed.

Before amending or rebasing, always check:

```bash
# Check if there's an open PR for the current branch
gh pr view --json state,isDraft -q '.state + " draft=" + (.isDraft|tostring)' 2>/dev/null
```

- **No PR or draft PR:** amend/rebase freely, then `git push --force-with-lease`
- **Open (non-draft) PR:** add a **new commit** instead — never amend, squash, or rebase

## Pushing

```bash
# Push current branch
git push

# First push of a new branch
git push -u origin HEAD

# Force push after rebase (only on personal branches, no open PR)
git push --force-with-lease
```

Never force push to `main` or shared branches.
Never force push a branch with an open (non-draft) PR.

## Branches

```bash
# Create and switch
git checkout -b feature/description

# Delete after merge
git branch -d feature/description
git push origin --delete feature/description
```

## Rules

1. **Commit by topic** — one logical change per commit, never mix unrelated changes
2. **Descriptive messages** — encode intent and context, not just "what"
3. **Pull with rebase** — `git pull --rebase` unless you want a merge commit
4. **Never force push shared branches** — use `--force-with-lease` on personal branches only
5. **Never amend/rebase with an open PR** — check `gh pr view` first; add new commits instead
6. **Stage precisely** — use `git add <files>` or `git add -p`, not `git add .`
