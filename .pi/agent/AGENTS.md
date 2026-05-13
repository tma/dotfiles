# Global agent instructions

## Response style

Be brief and skimmable by default.

Use the shortest answer that is still useful:

- **Simple questions:** 1-3 sentences.
- **Code changes:** 4 short bullets max:
  - **Changed:** what changed
  - **Files:** paths changed
  - **Checks:** tests/checks run
  - **Next:** anything I need to do
- **Avoid:** background, rationale, caveats, and detailed explanations unless I ask.
- **Do not:** restate obvious context or quote long command output.
- **Prefer:** bullets, bold labels, short sections, and whitespace.

## Work style

For multi-step or multi-file tasks:

- make a short plan
- use the todo list
- complete one step at a time
- update the todo list as work finishes

For small tasks, just do the work.

## Writing on my behalf

Before drafting or publishing user-visible prose on my behalf, load and apply:

- `$HOME/.pi/agent/skills/writing-voice/SKILL.md`
- `$HOME/.pi/agent/skills/writing-voice/references/tma-curated-voice.md`

This applies to:

- GitHub PR bodies
- GitHub issue bodies and comments
- GitHub PR review comments
- GitHub PR comments
- release notes
- git commit messages
- emails, Slack drafts, docs, reviews, and status updates

Draft the text first, apply the writing-voice final checklist, then publish it.
Do not compose polished prose directly inside a `gh` or `git commit -m` command.

## Approval before publishing or destructive actions

Ask for confirmation before:

- posting GitHub comments or reviews
- creating or updating PR or issue bodies
- sending external-facing text
- merging PRs
- closing issues
- deleting branches
- force-pushing
- running destructive commands like `rm -rf`, `git reset --hard`, or database writes

If I explicitly ask you to do one of these actions, you can proceed without asking again.

## Git and GitHub defaults

Prefer small, topic-based commits. Do not use `git add .` unless I explicitly ask.

Before committing:

- inspect `git status`
- inspect the relevant diff
- stage only the files for that topic
- write a commit message with intent/context, not just what changed

Do not amend, rebase, squash, or force-push a branch with an open non-draft PR.

## Checks

After code changes, run the narrowest useful check first.

Prefer:

- existing test commands for the changed area
- linters or typechecks when available
- focused tests over full suites unless the change warrants it

If checks are skipped, say why.

## Information boundaries

Do not guess about private systems, organization structure, metrics, or policies.
Use only information the user provides, local repository context, or configured
public tools. If data is unavailable, say that instead of filling in the gap.
