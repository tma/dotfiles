---
description: Review local git changes, current branch PR, or a specific PR URL
---
Review code changes. Accepts optional arguments: $ARGUMENTS

## 0. Determine review mode

Check if arguments contain a GitHub PR URL (e.g., `https://github.com/owner/repo/pull/123`).

**Mode A — PR URL provided:** Review the remote PR only. The PR may be for a different repo than the current directory. Skip local diff gathering entirely. Clone or fetch the repo if needed to read source files.

```bash
# Extract owner/repo and PR number from the URL
# e.g., https://github.com/owner/repo/pull/123 → owner/repo, 123
PR_URL="<the provided URL>"
PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
REPO=$(echo "$PR_URL" | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/[0-9]+|\1|')

# Fetch PR metadata
PR_JSON=$(gh pr view "$PR_URL" --json number,url,state,body,title,headRefName,baseRefName,files 2>/dev/null || true)

# Get the full diff
gh pr diff "$PR_URL"
```

Read all changed files in full from the PR's head branch for surrounding context. Use `gh api` with the repo slug, not local git commands, if the repo is not checked out locally.

**Mode B — No PR URL (default):** Review local changes and check for a PR on the current branch.

```bash
# Detect language/framework from repo root
ls -1 | head -20

# Get current branch and check for an open PR
BRANCH=$(git branch --show-current)
PR_JSON=$(gh pr view "$BRANCH" --json number,url,state,body,title 2>/dev/null || true)
```

Read the full diff — prefer staged, fall back to working tree, fall back to last commit:

```bash
DIFF=$(git diff --cached --stat 2>/dev/null)
if [ -z "$DIFF" ]; then
  DIFF=$(git diff --stat 2>/dev/null)
  if [ -z "$DIFF" ]; then
    echo "No staged or unstaged changes — reviewing last commit"
    git log -1 --oneline
    git diff HEAD~1 --stat
  else
    echo "No staged changes — reviewing working tree diff"
    git diff
  fi
else
  echo "Reviewing staged changes"
  git diff --cached
fi
```

For any changed file larger than 200 lines of diff, also read the full file for surrounding context.

---

From here on, follow the same process for both modes.

## 1. PR context (if PR exists)

If a PR was provided (Mode A) or found for the current branch (Mode B):

### Read the PR in full

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

# Linked issues referenced in the PR body or comments
echo "$PR_JSON" | jq -r '.body' | grep -oE '#[0-9]+' | sort -u
```

For each linked issue, read it in full including comments:
```bash
# For each linked issue number
gh issue view <ISSUE_NUM> --repo "$REPO" --json title,body,comments \
  --jq '{title: .title, body: .body, comments: [.comments[] | {user: .author.login, body: .body}]}'
```

Review the PR description, all comments, and linked issues alongside the diff. Consider whether the changes address PR feedback and linked issue requirements.

### Copilot review

Check for an existing Copilot review:

```bash
# List reviews, look for Copilot
gh api "repos/$REPO/pulls/$PR_NUM/reviews" \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" or .user.login == "github-actions[bot]" or (.user.type == "Bot" and (.user.login | test("copilot")))) | {id: .id, state: .state, submitted_at: .submitted_at}'
```

**If a Copilot review exists:**

1. Fetch all its review comments:
   ```bash
   gh api "repos/$REPO/pulls/$PR_NUM/comments" \
     --jq '.[] | select(.user.login | test("copilot|github-actions")) | {id: .id, path: .path, line: .original_line, body: .body, in_reply_to_id: .in_reply_to_id}'
   ```

2. For each Copilot comment:
   - Read the referenced file and line range for full context
   - Evaluate whether the comment is valid — does it identify a real issue?
   - If valid: fix the issue in the code, then reply to the comment confirming the fix with a brief explanation
   - If already addressed or not applicable: reply explaining why (e.g., "This is handled by X" or "False positive — the nil check is on line Y")
   - Reply using:
     ```bash
     gh api "repos/$REPO/pulls/$PR_NUM/comments/$COMMENT_ID/replies" \
       --method POST -f body="<your reply>"
     ```

3. After addressing all comments, re-request a review:
   ```bash
   gh pr review "$PR_NUM" --repo "$REPO" --request-changes=false 2>/dev/null || true
   ```

**If no Copilot review exists:**

1. Request one:
   ```bash
   gh pr edit "$PR_NUM" --repo "$REPO" --add-reviewer "copilot-pull-request-reviewer[bot]" 2>/dev/null || true
   ```

2. Wait for it to arrive (poll up to 3 minutes):
   ```bash
   for i in $(seq 1 18); do
     sleep 10
     REVIEW=$(gh api "repos/$REPO/pulls/$PR_NUM/reviews" \
       --jq '[.[] | select(.user.login | test("copilot"))] | length')
     if [ "$REVIEW" -gt 0 ]; then
       echo "Copilot review arrived after $((i * 10))s"
       break
     fi
     echo "Waiting for Copilot review... (${i}/18)"
   done
   ```

3. If the review arrives, process its comments using the same procedure above.
4. If it doesn't arrive after 3 minutes, continue with the manual review below.

## 2. Review checklist

Regardless of whether a Copilot review exists, perform your own review of each changed file:

**Correctness**
- Logic errors, off-by-one, nil/null dereference, missing returns
- Race conditions or unsafe concurrent access
- Incorrect error handling (swallowed errors, wrong error type, missing cleanup)
- Edge cases: empty input, zero values, boundary conditions

**Security**
- Injection risks (SQL, command, template)
- Secrets or credentials in code
- Unsafe deserialization, path traversal
- Missing authentication/authorization checks
- Overly permissive file/network access

**Reliability**
- Resource leaks (unclosed files, connections, goroutines, channels)
- Missing timeouts or context propagation
- Unbounded growth (maps, slices, channels without limits)
- Error messages that lose context (wrap errors, don't discard them)

**Style & maintainability**
- Naming: clear, consistent with the codebase conventions
- Dead code, commented-out code being added
- Missing or misleading comments
- API design: is the public interface minimal and clear?

**Performance** (only flag if clearly problematic)
- O(n²) or worse in hot paths
- Unnecessary allocations in loops
- Missing indexes for new queries
- N+1 query patterns

**Docs**
- Check if README or any documentation files (e.g., `docs/`, `*.md`) need updates based on the changes
- New features or changed behavior should be reflected in docs
- New config options, CLI flags, API endpoints, or environment variables should be documented
- If docs are stale or missing, flag it

**Tests**
- Are new code paths covered by tests?
- Are edge cases tested (empty input, error paths, boundary values)?
- Do existing tests still pass with the changes? Are any tests broken or need updating?
- Are there integration or system tests for critical user flows?
- If test coverage is missing for changed code, flag specifically what needs tests

## 3. Output format

Organize findings by severity:

### 🔴 Must fix
Issues that will cause bugs, security vulnerabilities, or data loss.

### 🟡 Should fix
Issues that hurt reliability, readability, or maintainability.

### 💡 Suggestions
Optional improvements — style nits, minor simplifications, better naming.

### ✅ What looks good
Briefly note what's well done — good test coverage, clean error handling, clear naming.

### 🤖 Copilot comments addressed
If a Copilot review was processed, summarize what was addressed: how many comments, which were fixed, which were dismissed, and why.

### 📋 PR context
If a PR exists, note whether the local changes address PR feedback and linked issue requirements. Flag any PR comments or issue requirements not yet addressed.

### 📝 Docs
Note whether documentation needs updating. If changes introduce new features, config, or behavioral changes without corresponding doc updates, flag it.

### 🧪 Tests
Summarize test coverage for the changes. List specific code paths or files that need tests but don't have them.

For each finding:
- Quote the relevant code (file + line range)
- Explain the issue concretely (not "this could be a problem" — say what goes wrong)
- Suggest a fix when possible

If the diff is clean with no issues, say so. Don't invent problems.
