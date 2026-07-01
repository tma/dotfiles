# GitHub PR and Local Diff Context

Use `gh` for all GitHub operations. Do not use raw API calls through `curl`.

## Mode A — PR URL provided

Review the remote PR only. The PR may be for a different repo than the current
directory. Skip local diff gathering entirely.

```bash
# Extract owner/repo and PR number from the URL
# e.g., https://github.com/owner/repo/pull/123 → owner/repo, 123
PR_URL="<the provided URL>"
PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
REPO=$(echo "$PR_URL" | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/[0-9]+|\1|')

# Fetch PR metadata
PR_JSON=$(gh pr view "$PR_URL" --json number,url,state,body,title,headRefName,baseRefName,files,closingIssuesReferences 2>/dev/null || true)

# Get the full diff
gh pr diff "$PR_URL"
```

Read changed files in full from the PR's head branch when surrounding context is
needed. If the repo is not checked out locally, use `gh api` with the repo slug
instead of local git commands.

Useful API patterns:

```bash
# PR files
PR_NUM=$(echo "$PR_JSON" | jq -r '.number')
REPO=$(echo "$PR_JSON" | jq -r '.url' | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/[0-9]+|\1|')
gh api "repos/$REPO/pulls/$PR_NUM/files" \
  --jq '.[] | {filename, status, additions, deletions, patch}'

# PR head/base refs
echo "$PR_JSON" | jq -r '{headRefName, baseRefName}'
```

## Mode B — No PR URL

Review local changes and check for a PR on the current branch.

```bash
# Detect language/framework from repo root
ls -1 | head -20

# Get current branch and check for an open PR
BRANCH=$(git branch --show-current)
PR_JSON=$(gh pr view "$BRANCH" --json number,url,state,body,title,closingIssuesReferences 2>/dev/null || true)
```

Read the full diff. Prefer staged, fall back to working tree, then last commit:

```bash
DIFF=$(git diff --cached --stat 2>/dev/null)
if [ -z "$DIFF" ]; then
  DIFF=$(git diff --stat 2>/dev/null)
  if [ -z "$DIFF" ]; then
    echo "No staged or unstaged changes — reviewing last commit"
    git log -1 --oneline
    git diff HEAD~1 --stat
    git diff HEAD~1
  else
    echo "No staged changes — reviewing working tree diff"
    git diff
  fi
else
  echo "Reviewing staged changes"
  git diff --cached
fi
```

For any changed file larger than 200 lines of diff, or any file where surrounding
context matters, read the full file.

## PR context when a PR exists

If a PR was provided or found for the current branch, read the PR in full.

```bash
PR_NUM=$(echo "$PR_JSON" | jq -r '.number')
REPO=$(echo "$PR_JSON" | jq -r '.url' | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/[0-9]+|\1|')

# PR description and title
echo "$PR_JSON" | jq -r '.title, .body'

# All PR comments (conversation)
gh api "repos/$REPO/issues/$PR_NUM/comments" \
  --jq '.[] | {user: .user.login, created_at: .created_at, body: .body}'

# All review comments (inline on code)
gh api "repos/$REPO/pulls/$PR_NUM/comments" \
  --jq '.[] | {user: .user.login, path: .path, line: .original_line, body: .body, in_reply_to_id: .in_reply_to_id}'

# Issues cross-referenced from the PR body. These may contain the motivation,
# data, research, design discussion, constraints, or acceptance criteria needed
# to review the change correctly.
echo "$PR_JSON" | jq -r '.body // ""' | grep -oE '(^|[^A-Za-z0-9_-])#[0-9]+' | grep -oE '[0-9]+' | sort -u

echo "$PR_JSON" | jq -r '.body // ""' | grep -oE '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+' | sort -u

echo "$PR_JSON" | jq -r '.body // ""' | grep -oE 'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[0-9]+' | sort -u

# Issues GitHub recognizes as closing references from the PR body.
echo "$PR_JSON" | jq -r '.closingIssuesReferences[]? | {number: .number, title: .title, url: .url}'
```

For each linked issue or issue URL from the PR body, read it in full including
comments. Use the current PR repo for plain `#123` references, and the referenced
repo for `owner/repo#123` or full issue URLs:

```bash
# Same-repo issue reference from #123
ISSUE_NUM="<number>"
gh issue view "$ISSUE_NUM" --repo "$REPO" --json title,body,comments \
  --jq '{title: .title, body: .body, comments: [.comments[] | {user: .author.login, body: .body}]}'

# Cross-repo issue reference from owner/repo#123 or a full issue URL
ISSUE_REPO="owner/repo"
ISSUE_NUM="<number>"
gh issue view "$ISSUE_NUM" --repo "$ISSUE_REPO" --json title,body,comments \
  --jq '{title: .title, body: .body, comments: [.comments[] | {user: .author.login, body: .body}]}'
```

Review the PR description, all comments, and PR-body cross-referenced issues
alongside the diff. Before judging the code, capture the relevant issue context:
motivation, data, research, design constraints, acceptance criteria, and any open
questions. Consider whether the changes address PR feedback and linked issue
requirements.
