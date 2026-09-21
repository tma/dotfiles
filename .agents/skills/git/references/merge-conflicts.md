# Resolving merge and rebase conflicts

Read this when a merge, rebase, cherry-pick, revert, or `git stash pop` stops with
conflicts.

The `git` skill's rules still apply: precise staging, no history rewriting when an
open non-draft PR exists, approval before destructive commands, and commit prose
that leads with why (apply the `writing-voice` skill and its curated profile
before writing any commit message).

## 1. Identify the operation first

The commands differ per operation. Establish which one is in progress before
reading anything else. Use `git rev-parse --git-path` so this works in worktrees.

```bash
git status --short
if [ -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then
  OP=merge
elif [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
  OP=rebase
elif [ -f "$(git rev-parse --git-path CHERRY_PICK_HEAD)" ]; then
  OP=cherry-pick
elif [ -f "$(git rev-parse --git-path REVERT_HEAD)" ]; then
  OP=revert
else
  OP=worktree   # a stash pop or an apply left conflicts; no operation is in progress
fi
echo "operation: $OP"
```

The incoming commit is named differently per operation:

| Operation | Incoming commit ref | Notes |
|-----------|---------------------|-------|
| merge | `MERGE_HEAD` | `HEAD` is your branch |
| rebase | `REBASE_HEAD` | the commit currently being replayed |
| cherry-pick | `CHERRY_PICK_HEAD` | |
| revert | `REVERT_HEAD` | the commit being undone |
| stash pop | none | compare against `stash@{0}` if the entry still exists |

A rebase stops once per commit. Everything below applies to the commit in front of
you, not to the whole branch.

## 2. Know which side is which

The index holds up to three stages per conflicted path:

```bash
git ls-files -u          # stage 1 = base, 2 = "ours", 3 = "theirs"
git show :1:"<path>"     # common ancestor, absent for add/add conflicts
git show :2:"<path>"     # "ours", absent when our side deleted the file
git show :3:"<path>"     # "theirs", absent when their side deleted the file
```

**During a rebase, "ours" and "theirs" are inverted from what you expect.** Git
replays your commits onto the upstream branch, so stage 2 ("ours", the `<<<<<<<`
block) is the upstream code you are rebasing onto, and stage 3 ("theirs", the
`>>>>>>>` block) is the commit from your own branch. The same inversion applies to
`git checkout --ours/--theirs` and to `-X ours/-X theirs`. Cherry-pick and revert
behave like rebase: stage 2 is the current `HEAD`, stage 3 is the change being
applied.

Missing stages tell you the conflict type:

- No stage 1: both sides added the file independently.
- No stage 2 or no stage 3: one side deleted what the other modified. Git cannot
  merge this for you. Decide whether the file should exist at all, then either
  `git rm -- "<path>"` or `git add -- "<path>"` after restoring the content you
  want.

## 3. Understand why each side changed

For each conflicted file, read the history on both sides. Use the ref that matches
the operation you identified in step 1:

```bash
# Merge: commits touching this file on each side
git log --oneline --left-right HEAD...MERGE_HEAD -- "<path>"
git show --stat MERGE_HEAD

# Rebase: the commit currently being replayed, from your own branch
git show --stat REBASE_HEAD

# Cherry-pick: the commit being applied
git show --stat CHERRY_PICK_HEAD

# Revert: the commit being undone. You are applying its inverse, so read it for
# what is being taken away and who depends on it, not as a change to keep.
git show --stat REVERT_HEAD

# Stash pop: the stashed work, when the entry still exists.
# Use the actual stash entry from the failed command, not always stash@{0}.
git diff "stash@{0}^1" "stash@{0}" -- "<path>"

# Either operation: what HEAD did to this file
git log -p HEAD -- "<path>"
```

Read the commit messages. When they reference a PR or issue, read it with `gh`:
the intent is usually in the PR description or the linked issue, not in the diff.
A conflict resolved without knowing why each side changed is a guess.

## 4. Resolve each conflict

- Preserve both intents when they are compatible. Most conflicts are two
  independent changes landing in the same lines.
- When they are genuinely incompatible, keep the one that matches the goal of the
  operation, and note the tradeoff in the commit message and in your report.
- Do not invent new behavior while resolving. Refactors and fixes are separate
  commits.
- Resolve the whole file, including changes the merge took from one side without
  conflicting.

Check for leftover markers using null-delimited paths, so paths with spaces are
handled. This is a diagnostic scan, not proof that the resolution is correct;
inspect each hit, including the base section from diff3 or zdiff3 conflicts.
Absent files in delete/modify conflicts have no contents to scan.

```bash
git diff --name-only --diff-filter=U -z | while IFS= read -r -d '' path; do
  [ -f "$path" ] || continue
  if grep -nE '^(<<<<<<<|=======|>>>>>>>|[|]{7})' -- "$path"; then
    echo "unresolved markers in: $path"
  fi
done
```

## 5. Run the project's checks

Find the repository's own commands (its test, typecheck, lint, or format scripts)
and run the narrowest useful ones over the affected area. A merge that compiles is
not a merge that works: conflicts often silence a call site both sides relied on.

Fix what the merge broke. Anything already broken beforehand is a separate report,
not a silent fix.

## 6. Stage only what you resolved

```bash
git add -- "<resolved-path>" "<another-resolved-path>"
git diff --cached --check
git diff --cached
git diff --name-only --diff-filter=U
git status
```

Inspect the staged diff and any staged conflict-marker or whitespace warnings.
Stop if `--check` fails or unmerged paths remain; do not commit or continue.
Keep unrelated staged work out of the operation rather than unstaging or
committing it without asking.

Never `git add .` or `git add -A` during a conflict. Unrelated working-tree
changes end up inside the merge commit, where nobody will look for them again.

## 7. Finish, or stop

Complete the operation only when the user's request covers it and nothing blocks
it. Write the commit message with the `git` skill's format and the `writing-voice`
skill's tone, leading with why:

```bash
git commit                  # merge: keeps the generated message; edit it to record any tradeoff
git rebase --continue
git cherry-pick --continue
git revert --continue
```

After a conflicted `git stash pop`, the stash entry is kept. Once the resolution
is staged and verified, ask before running `git stash drop`; dropping it is not
recoverable through normal commands.

Stop and ask instead when:

- The user only asked you to resolve the conflicts, or the repository's approval
  rules require confirmation for the next action.
- Continuing a rebase would rewrite history on a branch with an open, non-draft
  PR. Do not continue. Say so and propose a merge instead.
- A resolution needed a judgment call you are not confident about. Show both sides
  and let the user decide.
- The checks in step 5 fail for reasons the resolution cannot explain.

A rebase pauses at each commit. Continue through the remaining commits only if the
user asked you to finish the rebase, applying these steps at each stop.

## Aborting is a legitimate option

```bash
git merge --abort
git rebase --abort
git cherry-pick --abort
git revert --abort
```

Abort when the conflict shows the operation itself was wrong: the wrong base
branch, a rebase that should have been a merge, or a scope far larger than the
user expected. Never abort just because a conflict is hard.

**Ask before aborting, and inspect what is at risk first.** Abort restores the
pre-operation commit state, but uncommitted work from before the operation can be
lost, and the abort itself can fail when the working tree has changes it would
overwrite.

```bash
git status --short          # what is modified, staged, or untracked right now
git ls-files -u             # paths still unmerged
git stash list              # a stash pop conflict means the entry is still there
```

`git stash push` is not a rescue here: it refuses to run while the index has
unmerged entries, and a half-resolved conflict does not round-trip through a patch
file. Do not present either as a reliable snapshot.

When there is pre-existing uncommitted work or resolution work worth keeping, say
what it is and offer to copy the affected and untracked files to a location
outside the repository that the user approves, along with a note of the current
`git status` and unmerged paths. Tell the user plainly what cannot be restored
automatically. If an abort fails, report the error and stop; do not escalate to
`git reset --hard` or any other destructive command without explicit approval.

---

Adapted from Matt Pocock's `resolving-merge-conflicts` skill. See [third-party notices](../../THIRD_PARTY_NOTICES.md).
