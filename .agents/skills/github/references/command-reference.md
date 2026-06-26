# GitHub command reference

Use `gh` for GitHub operations. Prefer `--json` with `--jq` for structured data and `--body-file` for prose longer than one sentence.

## Large API bodies

For large `POST` or `PATCH` bodies, use `gh api --input -` with JSON on standard input instead of `-f body=...`; shell argument limits are easy to hit.

```bash
echo '{"body":"..."}' | gh api --method POST repos/owner/repo/issues/123/comments --input -
echo '{"body":"..."}' | gh api --method PATCH repos/owner/repo/issues/123 --input -
```

## Repository access

```bash
gh pr diff 123 --repo owner/repo
gh api repos/owner/repo/contents/path/to/file --jq .content | base64 -d
gh search code "ErrorName" --repo owner/repo
```

Use the repository and owner provided by the user or detected from the current repository. Do not assume private repository access or organization-specific context.

## Issues

```bash
# List open issues
gh issue list --repo owner/repo

# View issue details
gh issue view 123 --repo owner/repo --json title,body,comments

# Create an issue
gh issue create --repo owner/repo --title "Title" --body-file /tmp/issue-body.md

# Close with comment
gh issue close 123 --repo owner/repo --comment "Fixed in #456"

# Assign
gh issue edit 123 --repo owner/repo --add-assignee @me
```

## Pull requests

```bash
# List PRs
gh pr list --repo owner/repo

# View PR with diff
gh pr view 123 --repo owner/repo --json title,body,headRefName,baseRefName,files
gh pr diff 123 --repo owner/repo

# Create a PR
gh pr create --title "Title" --body-file /tmp/pr-body.md --base main

# Review comments
gh api repos/owner/repo/pulls/123/comments \
  --jq '.[] | {user: .user.login, path: .path, line: .original_line, body: .body}'

# Merge
gh pr merge 123 --squash --delete-branch
```

## Copilot PR reviews

When the user asks for a GitHub Copilot review on a PR, use the requested-reviewer flow, not a PR comment.

```bash
# Check whether Copilot is already requested
gh api repos/owner/repo/pulls/123/requested_reviewers \
  --jq '{users: [.users[]?.login], teams: [.teams[]?.slug]}'

# Check whether Copilot has already reviewed
gh api repos/owner/repo/pulls/123/reviews \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" or (.user.type == "Bot" and (.user.login | test("copilot")))) | {user: .user.login, state: .state, submitted_at: .submitted_at}'

# Request the real Copilot reviewer bot
gh pr edit 123 --repo owner/repo --add-reviewer "copilot-pull-request-reviewer[bot]"

# Poll if the user wants to wait for the review
for i in $(seq 1 18); do
  sleep 10
  REVIEW=$(gh api repos/owner/repo/pulls/123/reviews \
    --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" or (.user.type == "Bot" and (.user.login | test("copilot"))))] | length')
  [ "$REVIEW" -gt 0 ] && echo "Copilot review arrived" && break
  echo "Waiting for Copilot review... (${i}/18)"
done

# Fetch Copilot inline comments
gh api repos/owner/repo/pulls/123/comments \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" or (.user.type == "Bot" and (.user.login | test("copilot")))) | {id: .id, path: .path, line: .original_line, body: .body}'
```

Never try to trigger Copilot review by posting `@copilot` in a PR or issue comment. That does not create the requested-reviewer review flow.

## Repository

```bash
# Clone
gh repo clone owner/repo

# View repository information
gh repo view owner/repo --json name,description,defaultBranchRef

# List branches
gh api repos/owner/repo/branches --jq '.[].name'

# Create repository
gh repo create my-repository --private --clone
```

## GitHub Actions

```bash
# List workflow runs
gh run list --repo owner/repo --limit 10

# View run details
gh run view 12345 --repo owner/repo

# View logs
gh run view 12345 --repo owner/repo --log

# Re-run failed jobs
gh run rerun 12345 --repo owner/repo --failed

# Watch a running workflow
gh run watch 12345 --repo owner/repo
```

## Codespaces

```bash
# List codespaces
gh cs list --json name,repository,gitStatus,state

# Find codespace by repository and branch
gh cs list --repo owner/repo --json name,gitStatus,state \
  | jq '.[] | select(.gitStatus.ref == "my-branch")'

# Create
gh cs create --repo owner/repo --branch my-branch --default-permissions

# Start a stopped codespace
gh cs start --codespace <name>

# SSH into codespace
gh cs ssh --codespace <name>

# Run a command
gh cs ssh --codespace <name> -- "cd /workspaces/repository && make test"

# Stop
gh cs stop --codespace <name>
```

## Advanced API

```bash
# GET
gh api repos/owner/repo/releases/latest --jq '.tag_name'

# POST
gh api repos/owner/repo/issues/123/comments -f body="Comment text"

# With pagination
gh api repos/owner/repo/issues --paginate --jq '.[].title'

# GraphQL
gh api graphql -f query='{ viewer { login } }'
```

## Search

```bash
# Search issues
gh search issues "auth bug" --repo owner/repo --state open

# Search code
gh search code "func main" --repo owner/repo --extension go

# Search PRs
gh search prs "review:approved" --repo owner/repo
```
