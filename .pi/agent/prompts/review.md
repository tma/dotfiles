---
description: Review local git changes, current branch PR, or a specific PR URL
argument-hint: "[PR-URL]"
---

Load and use the `code-review` skill to review code changes.

Arguments: $ARGUMENTS

Review target selection:

- If arguments include a GitHub PR URL, review that remote PR.
- Otherwise, review local staged changes, then working tree changes, then the
  last commit.
- If the current branch has an open PR, include the PR body, comments, review
  comments, and linked issue context.

Follow the `code-review` skill output format. Do not post GitHub comments or a
review unless I explicitly ask you to publish them.
