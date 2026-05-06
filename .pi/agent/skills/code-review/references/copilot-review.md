# Copilot Review Workflow

Use this only when the user asks for a GitHub Copilot review or asks you to
process Copilot's existing review comments.

Never post a PR comment or issue comment like `@copilot review this`. That does
not trigger the proper Copilot code review. Use the requested-reviewer flow.

## Check for an existing Copilot review

```bash
# List reviews, look for the Copilot reviewer bot
gh api "repos/$REPO/pulls/$PR_NUM/reviews" \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" or (.user.type == "Bot" and (.user.login | test("copilot")))) | {id: .id, user: .user.login, state: .state, submitted_at: .submitted_at}'
```

## If a Copilot review exists

Fetch all Copilot review comments:

```bash
gh api "repos/$REPO/pulls/$PR_NUM/comments" \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" or (.user.type == "Bot" and (.user.login | test("copilot")))) | {id: .id, path: .path, line: .original_line, body: .body, in_reply_to_id: .in_reply_to_id}'
```

For each Copilot comment:

1. Read the referenced file and line range for full context.
2. Evaluate whether the comment identifies a real issue.
3. If valid, fix the issue in code.
4. If already addressed or not applicable, prepare a short explanation.
5. If replying on GitHub, apply `writing-voice` first and ask for confirmation
   unless the user explicitly asked you to post replies.

Reply to a Copilot comment with:

```bash
gh api "repos/$REPO/pulls/$PR_NUM/comments/$COMMENT_ID/replies" \
  --method POST -f body="<your reply>"
```

After addressing all comments, request another Copilot review by re-adding the
Copilot reviewer bot:

```bash
gh pr edit "$PR_NUM" --repo "$REPO" --add-reviewer "copilot-pull-request-reviewer[bot]" 2>/dev/null || true
```

Do not use `gh pr review` here. That submits your own review; it does not request
a Copilot review.

## If no Copilot review exists

Request one by adding the Copilot reviewer bot as a requested reviewer:

```bash
gh pr edit "$PR_NUM" --repo "$REPO" --add-reviewer "copilot-pull-request-reviewer[bot]" 2>/dev/null || true
```

Confirm the current requested reviewers:

```bash
gh api "repos/$REPO/pulls/$PR_NUM/requested_reviewers" \
  --jq '{users: [.users[]?.login], teams: [.teams[]?.slug]}'
```

Wait for it to arrive, polling up to 3 minutes:

```bash
for i in $(seq 1 18); do
  sleep 10
  REVIEW=$(gh api "repos/$REPO/pulls/$PR_NUM/reviews" \
    --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" or (.user.type == "Bot" and (.user.login | test("copilot"))))] | length')
  if [ "$REVIEW" -gt 0 ]; then
    echo "Copilot review arrived after $((i * 10))s"
    break
  fi
  echo "Waiting for Copilot review... (${i}/18)"
done
```

If the review arrives, process its comments using the same procedure above. If it
does not arrive after 3 minutes, continue with the manual review.
