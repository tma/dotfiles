---
description: Review staged git changes (or working tree diff) for bugs, security, and style
---
Review the current changes for this repository. Follow this process:

## 1. Gather context

```bash
# Detect language/framework from repo root
ls -1 | head -20

# Get current branch and check for an open PR
BRANCH=$(git branch --show-current)
PR_JSON=$(gh pr view "$BRANCH" --json number,url,state 2>/dev/null || true)
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

## 2. Copilot review (if PR exists)

If a PR exists for this branch:

### Check for existing Copilot review

```bash
PR_NUM=$(echo "$PR_JSON" | jq -r '.number')

# List reviews, look for Copilot
gh api "repos/{owner}/{repo}/pulls/$PR_NUM/reviews" \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" or .user.login == "github-actions[bot]" or (.user.type == "Bot" and (.user.login | test("copilot")))) | {id: .id, state: .state, submitted_at: .submitted_at}'
```

**If a Copilot review exists:**

1. Fetch all its review comments:
   ```bash
   gh api "repos/{owner}/{repo}/pulls/$PR_NUM/comments" \
     --jq '.[] | select(.user.login | test("copilot|github-actions")) | {id: .id, path: .path, line: .original_line, body: .body, in_reply_to_id: .in_reply_to_id}'
   ```

2. For each Copilot comment:
   - Read the referenced file and line range for full context
   - Evaluate whether the comment is valid — does it identify a real issue?
   - If valid: fix the issue in the code, then reply to the comment confirming the fix with a brief explanation
   - If already addressed or not applicable: reply explaining why (e.g., "This is handled by X" or "False positive — the nil check is on line Y")
   - Reply using:
     ```bash
     gh api "repos/{owner}/{repo}/pulls/$PR_NUM/comments/$COMMENT_ID/replies" \
       --method POST -f body="<your reply>"
     ```

3. After addressing all comments, re-request a review:
   ```bash
   gh pr review "$PR_NUM" --request-changes=false 2>/dev/null || true
   ```

**If no Copilot review exists:**

1. Request one:
   ```bash
   gh pr edit "$PR_NUM" --add-reviewer "copilot-pull-request-reviewer[bot]" 2>/dev/null || true
   ```

2. Wait for it to arrive (poll up to 3 minutes):
   ```bash
   for i in $(seq 1 18); do
     sleep 10
     REVIEW=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUM/reviews" \
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

## 3. Review checklist

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
- Test coverage: are new code paths tested? Are edge cases covered?
- API design: is the public interface minimal and clear?

**Performance** (only flag if clearly problematic)
- O(n²) or worse in hot paths
- Unnecessary allocations in loops
- Missing indexes for new queries
- N+1 query patterns

## 4. Output format

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

For each finding:
- Quote the relevant code (file + line range)
- Explain the issue concretely (not "this could be a problem" — say what goes wrong)
- Suggest a fix when possible

If the diff is clean with no issues, say so. Don't invent problems.
