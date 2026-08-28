# Git workflow reference

Use these examples after loading the `git` skill. Stage specific files for each topic; do not use `git add .` unless the user explicitly asks.

## Starting from the latest default branch

```bash
# Detect default branch from origin/HEAD
DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')

# Fall back to gh when origin/HEAD is unavailable
DEFAULT_BRANCH=${DEFAULT_BRANCH:-$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)}

git fetch origin
git switch "$DEFAULT_BRANCH"
git pull --rebase origin "$DEFAULT_BRANCH"
git switch -c tma/feature/description
```

Use the `tma/` prefix only when the branch naming rule requires it.

## Branch naming examples

For `github.com/owner/repo` where `owner != tma`:

```bash
git switch -c tma/feature/description
git worktree add -b tma/feature/description ../repository-feature origin/main
```

Do not require the `tma/` prefix when:

- `origin` is on `github.com` and the owner is `tma`
- `origin` is not on `github.com`

When creating branches for worktrees, apply the same rule to the `-b` branch name.

## Topic-based commits

When multiple files were changed across different topics:

1. Review all changes with `git diff` and `git status`.
2. Identify distinct topics, for example one feature, one bug fix, or one configuration update.
3. Stage and commit each topic separately using `git add <specific files>`.
4. Order commits logically: foundations first, dependents after.

```bash
# Stage specific files for one topic
git add path/to/related-file-1 path/to/related-file-2
git commit -F /tmp/commit-message

# Then commit the next topic
git add path/to/other-file
git commit -F /tmp/commit-message
```

Use `git add -p` when a single file contains changes belonging to different topics.

## Commit messages

Before writing a commit message on tma's behalf, apply the `writing-voice` skill and its curated profile. The git skill owns the format; the writing-voice skill owns the tone.

Lead every message with why the commit exists: the intended outcome, the problem being solved, or the risk being avoided. Put implementation details second. Someone reading the log should understand why without opening the diff.

Prefer subjects shaped like `<intended outcome> by <mechanism>`. If the why cannot fit clearly in the subject, state it in the first body paragraph before explaining the implementation. Never open with filenames, code mechanics, or a change list.

For multi-line messages, draft the message first and use:

```bash
git commit -F /tmp/commit-message
```

Avoid composing non-trivial commit messages directly inside `git commit -m`.

Format:

```text
<imperative intended outcome, followed by the mechanism when useful>

<why this change is needed and why it matters, required when the
subject does not make the why clear>

Optional implementation detail:
<how the change achieves that outcome, including trade-offs if relevant>

<related issues or links>
```

Good:

```text
prevent multi-session collisions by scoping status files

Multiple pi sessions in the same directory were overwriting each
other's stats and todos files. Scope filenames by process.pid and
pass PI_PID environment variable to the status panel shell script.
```

Bad because they are too vague:

```text
update files
fix bug
changes
WIP
```

Bad because it leads with the mechanism and omits why:

```text
scope status files by PID
```

Prefer `prevent multi-session collisions by scoping status files`.

Rules:

- Lead with the intended outcome, problem, or avoided risk; put implementation details second.
- Use imperative mood: `add`, `fix`, `refactor`; not `added` or `fixes`.
- Keep the first line under 72 characters.
- Do not put a period at the end of the summary line.
- Wrap the body at 72 characters.
- Reference issue numbers when applicable.

## Pulling

Pull with rebase by default:

```bash
git pull --rebase
```

Exception: when a PR is open and not in draft, others may have already reviewed the commits. Rebasing would force-push and break review history. In that case, use a regular merge pull:

```bash
git pull
```

Configure rebase as default:

```bash
git config --global pull.rebase true
```

Before pulling, stash or commit local changes first:

```bash
git stash
git pull --rebase
git stash pop
```

## Amending and rewriting history

Before amending or rebasing, check whether there is an open PR for the current branch:

```bash
gh pr view --json state,isDraft -q '.state + " draft=" + (.isDraft|tostring)' 2>/dev/null
```

- No PR or draft PR: amend or rebase freely, then `git push --force-with-lease`.
- Open, non-draft PR: add a new commit instead. Never amend, squash, or rebase.

## Pushing

```bash
# Push current branch
git push

# First push of a new branch
git push -u origin HEAD

# Force push after rebase, only on personal branches with no open PR
git push --force-with-lease
```

Never force push to `main` or shared branches. Never force push a branch with an open, non-draft PR.

## Branch cleanup

```bash
# Delete after merge
git branch -d tma/feature/description
git push origin --delete tma/feature/description
```
