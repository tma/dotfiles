# Copilot Review Workflow

Use this only when the user asks for a GitHub Copilot review or asks you to
process Copilot's existing review comments.

Never post a PR comment like `@copilot review this`. That does not create a
Copilot review. Use the requested-reviewer flow below.

All GitHub access goes through `gh`. Do not call the API with `curl`, and do not
suppress errors: "no Copilot review exists" and "the API call failed" are
different states that need different responses.

## Setup

Run these snippets in one Bash session, or repeat Setup in each fresh shell.
Use a `gh` version supporting `--paginate --slurp`, plus `jq`. `set -o pipefail`
matters: without it, a failed `gh` call can look like a successful `jq` call.
Keep stderr separate from captured JSON; even successful commands can warn.

```bash
set -o pipefail
REPO="owner/repo"
PR_NUM="123"

# Submitted Copilot reviews across all pages, newest last.
# --paginate --slurp wraps all page arrays; .[][] flattens them.
# Pending reviews must not enter a baseline before they are submitted.
copilot_submitted_reviews() {
  gh api "repos/$REPO/pulls/$PR_NUM/reviews" --paginate --slurp \
    | jq -c '[ .[][]
        | select(.user.login == "copilot-pull-request-reviewer[bot]"
                 or (.user.type == "Bot" and (.user.login | test("copilot"; "i"))))
        | select(.state != "PENDING" and .submitted_at != null)
        | {id, state, submitted_at, body} ]
      | sort_by(.submitted_at)'
}

# Copilot inline comments across all pages. Pass a review ID to limit to one review.
copilot_comments() {
  gh api "repos/$REPO/pulls/$PR_NUM/comments" --paginate --slurp \
    | jq -c --argjson review_id "${1:-null}" '[ .[][]
        | select(.user.login == "copilot-pull-request-reviewer[bot]"
                 or (.user.type == "Bot" and (.user.login | test("copilot"; "i"))))
        | select($review_id == null or .pull_request_review_id == $review_id)
        | {id, path, line: .original_line, body, in_reply_to_id} ]'
}
```

Every call below stops on failure. In a script, that means `exit 1`; when running
commands one at a time, a non-zero status means stop and report the visible error
to the user rather than continuing with an unknown review state.

## Check for an existing Copilot review

```bash
if ! REVIEWS=$(copilot_submitted_reviews); then
  printf 'Could not list Copilot reviews; see the error above.\n' >&2
  exit 1
fi
printf '%s\n' "$REVIEWS"
```

Three outcomes, each handled differently:

- **`REVIEWS` contains entries** — read the review bodies, then process inline
  comments below. A review with no inline comments can still contain findings in
  its body; an empty comment list is not proof of a clean review.
- **`REVIEWS` is `[]`** — no submitted Copilot review. Request one below if that
  was requested; a request only to read existing feedback does not authorize it.
- **The call failed** — report the error and stop. Never treat an API or
  authentication failure as "no review".

## Process existing Copilot feedback

Respect the user's requested scope. By default, consider existing review bodies
and comments, not only the latest review. Pass a review ID to `copilot_comments`
when the user names one specific review.

```bash
if ! COMMENTS=$(copilot_comments); then
  printf 'Could not list Copilot comments; see the error above.\n' >&2
  exit 1
fi
printf '%s\n' "$COMMENTS" | jq -c '.[]'
```

For each finding in a body or inline comment:

1. Read the referenced file and line range for full context.
2. Decide whether it identifies a real issue in the current code; older findings
   may already be addressed.
3. If valid and the user asked for fixes, fix it in code. Review-only requests
   produce findings, not edits.
4. If already addressed or not applicable, prepare a short explanation.
5. If replying on GitHub, apply the `writing-voice` skill first and ask for
   confirmation unless the user already asked you to post replies.

Reply to a specific inline comment:

```bash
gh api "repos/$REPO/pulls/$PR_NUM/comments/$COMMENT_ID/replies" \
  --method POST -f body="<your reply>"
```

## Request a Copilot review

Request only when the user asked for it. Record a baseline of submitted review IDs
first. Without it, a poll can mistake a review that was already there for the new
one.

```bash
if ! BEFORE=$(copilot_submitted_reviews); then
  printf 'Could not take the review baseline; see the error above.\n' >&2
  exit 1
fi
BASELINE=$(printf '%s' "$BEFORE" | jq -c '[.[].id]')
printf 'baseline Copilot review IDs: %s\n' "$BASELINE"
```

Then request the reviewer. Let the command's exit status stand:

```bash
if ! gh pr edit "$PR_NUM" --repo "$REPO" \
  --add-reviewer "copilot-pull-request-reviewer[bot]"; then
  printf 'Could not request the Copilot reviewer; see the error above.\n' >&2
  exit 1
fi
```

Common causes when that fails: Copilot code review is not enabled for the
repository, the token lacks permission, or the PR is closed. Report which one the
error indicates. Do not poll for a review nobody requested.

Check the requested-reviewer state:

```bash
if ! gh api "repos/$REPO/pulls/$PR_NUM/requested_reviewers" \
  --jq '{users: [.users[]?.login], teams: [.teams[]?.slug]}'; then
  printf 'Could not verify the request state; see the error above.\n' >&2
  exit 1
fi
```

A fast review may already have completed and disappeared from requested reviewers;
check for a new submitted review before concluding the request did not land.

## Wait for the new review

Poll for a submitted Copilot review whose ID is not in the baseline. Do this only
when the user wants to wait; otherwise say it was requested and move on.

```bash
NEW_REVIEW=""
POLL_ERROR=""
for i in $(seq 1 18); do
  sleep 10
  if ! CURRENT=$(copilot_submitted_reviews); then
    POLL_ERROR="Could not list Copilot reviews; see the error above."
    break
  fi
  NEW_REVIEW=$(printf '%s' "$CURRENT" | jq -c --argjson baseline "$BASELINE" \
    '[ .[] | . as $review | select(($baseline | index($review.id)) == null) ]
      | sort_by(.submitted_at) | last // empty')
  if [ -n "$NEW_REVIEW" ]; then
    printf 'new Copilot review after %ss: %s\n' "$((i * 10))" "$NEW_REVIEW"
    break
  fi
  printf 'waiting for a new Copilot review... (%s/18)\n' "$i"
done
```

Report the outcome you actually got:

- **New review** — `NEW_REVIEW` is non-empty. Read its body and process its
  comments, passing its ID to `copilot_comments` so older comments are not
  re-litigated. Report body-only feedback even if there are no inline comments.
- **Timeout** — the loop finished with both variables empty. Say the review did not
  arrive within the polling window, that it may still land later, and continue
  with your own review. There are 18 ten-second waits plus API request time.
- **API or authentication failure** — `POLL_ERROR` is non-empty. Report it and
  stop. The review state is unknown, not absent.

```bash
if [ -n "$POLL_ERROR" ]; then
  printf '%s\n' "$POLL_ERROR" >&2
  exit 1
fi
if [ -n "$NEW_REVIEW" ]; then
  printf '%s\n' "$NEW_REVIEW" | jq '{id, state, body}'
  REVIEW_ID=$(printf '%s' "$NEW_REVIEW" | jq -r '.id')
  if ! COMMENTS=$(copilot_comments "$REVIEW_ID"); then
    printf 'Could not list Copilot comments; see the error above.\n' >&2
    exit 1
  fi
  printf '%s\n' "$COMMENTS" | jq -c '.[]'
fi
```

## Re-requesting after fixes

When the user wants another review, use the same procedure: take a fresh baseline
of submitted Copilot review IDs, request the reviewer again, then poll for an ID
outside that baseline. Never reuse a baseline from earlier in the session, and
never conclude from comment counts that a new review arrived.

Do not use `gh pr review` here. That submits your own review; it does not request
a Copilot review.
