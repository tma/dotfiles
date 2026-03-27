---
name: second-opinion
description: Gets an independent code review from external LLMs (Codex, Gemini) on uncommitted changes, branch diffs, or specific commits. Combines the review prompt checklist with a second model's perspective. Use when the user asks for a second opinion, external review, or an independent perspective on code changes.
---

# Second Opinion

Shell out to external LLM CLIs for an independent code review from a different model.
Uses the project's review checklist so the external model applies the same standards.

## When to Use

- Getting a second opinion on code changes from a different model
- Reviewing branch diffs before opening a PR
- Checking uncommitted work before committing
- Running a focused review (security, performance, error handling)
- Comparing review perspectives from multiple models

## When NOT to Use

- Neither Codex CLI nor Gemini CLI is installed
- No changes to review
- You want pi's own review — use `/review` instead

## 1. Gather Parameters

Determine scope, tool, and focus from the user's request. If not specified, ask.

**Scope** (what to review):
- `uncommitted` — `git diff HEAD` + untracked files
- `branch` — `git diff <default-branch>...HEAD`
- `commit` — `git diff <sha>~1..<sha>`
- A GitHub PR URL — `gh pr diff <url>`

**Tool** (which external LLM):
- `both` — run Codex and Gemini in parallel (default if both available)
- `codex` — OpenAI Codex CLI only
- `gemini` — Google Gemini CLI only

**Focus** (optional):
- `general` — full review (default)
- `security` — security-focused
- `performance` — performance-focused
- `errors` — error handling focus

## 2. Detect Default Branch

```bash
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
  | sed 's@^refs/remotes/origin/@@' || echo main
```

## 3. Gather the Diff

```bash
# Uncommitted (default)
DIFF=$(git diff HEAD 2>/dev/null)
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null)
if [ -z "$DIFF" ] && [ -z "$UNTRACKED" ]; then
  # Fall back to last commit
  DIFF=$(git diff HEAD~1 2>/dev/null)
fi

# Branch diff
DIFF=$(git diff <default-branch>...HEAD 2>/dev/null)

# Specific commit
DIFF=$(git diff <sha>~1..<sha> 2>/dev/null)

# PR URL
DIFF=$(gh pr diff "<url>" 2>/dev/null)
```

Show diff stats first. If empty, stop. If >2000 lines, warn and ask whether to proceed.

```bash
echo "$DIFF" | diffstat 2>/dev/null || echo "$DIFF" | head -5
```

## 4. Build the Review Prompt

Read the review checklist from the project's review prompt (single source of truth):

```bash
# Project-level first, fall back to global
REVIEW_PROMPT=$(cat .pi/agent/prompts/review.md 2>/dev/null \
  || cat .pi/prompts/review.md 2>/dev/null \
  || cat ~/.pi/agent/prompts/review.md 2>/dev/null \
  || echo "")
```

If no review prompt is found, use a minimal default: correctness, security, reliability, style, tests.

Write a temp file combining everything:

```bash
PROMPT_FILE=$(mktemp /tmp/second-opinion-prompt.XXXXXX.md)
```

The prompt sent to the external LLM should include:
1. The review checklist extracted from the review prompt (section 2 "Review checklist")
2. Focus area instructions (if not general)
3. The full diff
4. Any project context (CLAUDE.md, AGENTS.md, or CONVENTIONS.md if present)

## 5. Run External Reviews

### Codex

```bash
codex exec \
  --model gpt-5.4 \
  --reasoning xhigh \
  --sandbox read-only \
  --ephemeral \
  -o /tmp/second-opinion-codex-out.md \
  - < "$PROMPT_FILE"
```

Set `timeout: 600` on the bash call. If auth error, retry with `gpt-5.3-codex`.

### Gemini

For uncommitted general review:
```bash
gemini -p "/code-review" --yolo -e code-review
```

For all other scopes or focused reviews, pipe the prompt:
```bash
gemini -p - --yolo -m gemini-3.1-pro < "$PROMPT_FILE"
```

Set `timeout: 600` on the bash call.

### Running Both

When running both, issue both bash calls in the same response so they run in parallel. Both are read-only operations.

## 6. Present Results

### Single tool output

Present the external review directly, organized by severity using the standard format:

- 🔴 **Must fix** — bugs, security issues, data loss
- 🟡 **Should fix** — reliability, readability, maintainability
- 💡 **Suggestions** — style nits, minor improvements
- ✅ **What looks good** — well-done aspects

### Both tools output

Present with clear headers, then add a comparison:

```
## Codex Review (gpt-5.4)
<codex findings>

## Gemini Review (gemini-3.1-pro)
<gemini findings>

## Comparison
Where the two reviews agree and where they differ.
Consensus issues are higher confidence. Unique findings
from each model are worth investigating.
```

### Integration with pi's own view

After presenting external results, briefly note whether you agree or disagree with specific findings. Flag any false positives you spot in the external reviews.

## 7. Cleanup

```bash
rm -f "$PROMPT_FILE" /tmp/second-opinion-codex-out.md
```

## Error Handling

| Error | Action |
|-------|--------|
| `codex: command not found` | Tell user: `npm i -g @openai/codex` |
| `gemini: command not found` | Tell user: `npm i -g @google/gemini-cli` |
| Gemini `code-review` extension missing | Tell user: `gemini extensions install https://github.com/gemini-cli-extensions/code-review` |
| Model auth error (Codex) | Retry with `gpt-5.3-codex` |
| Empty diff | Tell user there are no changes to review |
| Timeout | Inform user and suggest narrowing scope |
| Tool partially unavailable | Run only the available tool, note the skip |

## Examples

```
User: /skill:second-opinion
→ Asks scope + tool + focus
→ Gathers diff, builds prompt with checklist
→ Shells out to Codex and/or Gemini
→ Presents findings with severity levels
→ Adds pi's own take on the external findings

User: /skill:second-opinion check my branch for security issues
→ Scope: branch, Focus: security (both inferred)
→ Asks only which tool
→ Runs review with security-focused prompt

User: /skill:second-opinion https://github.com/org/repo/pull/42
→ Scope: PR URL (inferred)
→ Fetches PR diff via gh
→ Runs external review on the PR changes
```
