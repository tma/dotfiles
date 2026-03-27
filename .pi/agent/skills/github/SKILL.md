---
name: github
description: Interact with GitHub — issues, PRs, repos, Actions, Codespaces, and API. Use when the task involves anything on GitHub. Always use the gh CLI, never raw API calls or curl.
---

# GitHub

Use the `gh` CLI for all GitHub operations. Never use `curl` with raw API URLs or the `octokit` library — `gh` handles authentication, pagination, and API versioning automatically.

## Authentication

Already configured. `gh auth status` to verify. Do not ask for tokens.

## Common Operations

### Issues

```bash
# List open issues
gh issue list --repo owner/repo

# View issue details
gh issue view 123 --repo owner/repo --json title,body,comments

# Create an issue
gh issue create --repo owner/repo --title "Title" --body "Body"

# Close with comment
gh issue close 123 --repo owner/repo --comment "Fixed in #456"

# Assign
gh issue edit 123 --repo owner/repo --add-assignee @me
```

### Pull Requests

```bash
# List PRs
gh pr list --repo owner/repo

# View PR with diff
gh pr view 123 --repo owner/repo --json title,body,headRefName,baseRefName,files
gh pr diff 123 --repo owner/repo

# Create a PR
gh pr create --title "Title" --body "Description" --base main

# Review comments
gh api repos/owner/repo/pulls/123/comments \
  --jq '.[] | {user: .user.login, path: .path, line: .original_line, body: .body}'

# Merge
gh pr merge 123 --squash --delete-branch
```

### Repository

```bash
# Clone
gh repo clone owner/repo

# View repo info
gh repo view owner/repo --json name,description,defaultBranchRef

# List branches
gh api repos/owner/repo/branches --jq '.[].name'

# Create repo
gh repo create my-repo --private --clone
```

### GitHub Actions

```bash
# List workflow runs
gh run list --repo owner/repo --limit 10

# View run details
gh run view 12345 --repo owner/repo

# View logs
gh run view 12345 --repo owner/repo --log

# Re-run failed
gh run rerun 12345 --repo owner/repo --failed

# Watch a running workflow
gh run watch 12345 --repo owner/repo
```

### Codespaces

```bash
# List codespaces
gh cs list --json name,repository,gitStatus,state

# Find codespace by repo+branch
gh cs list --repo owner/repo --json name,gitStatus,state \
  | jq '.[] | select(.gitStatus.ref == "my-branch")'

# Create
gh cs create --repo owner/repo --branch my-branch --default-permissions

# Start a stopped codespace
gh cs start --codespace <name>

# SSH into codespace
gh cs ssh --codespace <name>

# Run a command
gh cs ssh --codespace <name> -- "cd /workspaces/repo && make test"

# Stop
gh cs stop --codespace <name>
```

### Advanced API

For anything `gh` subcommands don't cover, use `gh api`:

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

### Search

```bash
# Search issues
gh search issues "auth bug" --repo owner/repo --state open

# Search code
gh search code "func main" --repo owner/repo --extension go

# Search PRs
gh search prs "review:approved" --repo owner/repo
```

## Rules

1. **Always use `gh` CLI** — never `curl`, `fetch`, or direct HTTP to `api.github.com`
2. **Use `--repo owner/repo`** when not in the target repo's directory
3. **Use `--json` + `--jq`** for structured output — don't parse human-readable text
4. **Use `gh api`** for endpoints without a dedicated subcommand
5. **Paginate with `--paginate`** when listing — default page size is 30
6. **Don't create tokens** — `gh` manages auth automatically
