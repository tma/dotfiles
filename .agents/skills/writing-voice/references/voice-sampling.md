# Voice sampling

Use this only when no curated or cached profile exists, or when the curated profile needs more signal. For tma, `references/tma-curated-voice.md` is the baseline; sample only on mismatch, user request, or when the profile is not enough for the format.

More samples improve the match. Analyze 10–20 samples when available.

## Source 1: GitHub activity

Pull unpolished, natural writing: PR descriptions, issue/PR comments, and reviews. Sample 2025 or earlier to avoid recent AI-assisted text. Replace `owner` with the organization or account supplied by the user.

```bash
USERNAME=$(gh api user --jq .login)

# 15 longest PR descriptions
gh search prs --author="$USERNAME" --owner=owner --created='<2026-01-01' --limit=50 \
  --json url,title,body | python3 -c "
import sys, json
prs = [p for p in json.load(sys.stdin) if len(p.get('body') or '') > 150]
for p in sorted(prs, key=lambda p: -len(p['body']))[:15]:
    print(json.dumps({'type':'pr','url':p['url'],'body':p['body']}))
"

# 15 longest issue/PR comments
gh api "search/issues?q=commenter:$USERNAME+org:owner+created:<2026-01-01&per_page=20" \
  --jq '.items[].url' | head -20 | while read url; do
    REPO=$(echo "$url" | sed -E 's|.*repos/||;s|/(issues\|pulls)/.*||')
    NUM=$(echo "$url" | sed -E 's|.*/||')
    gh api "repos/$REPO/issues/$NUM/comments" --paginate \
      --jq ".[] | select(.user.login==\"$USERNAME\") | {body, url: .html_url}" 2>/dev/null
    sleep 0.2
done | python3 -c "
import sys, json
cs = [json.loads(l) for l in sys.stdin if l.strip()]
for c in sorted([c for c in cs if len(c['body'])>100], key=lambda c:-len(c['body']))[:15]:
    print(json.dumps(c))
"

# Review bodies: technical/evaluative voice
gh api "search/issues?q=reviewed-by:$USERNAME+org:owner+type:pr+created:<2026-01-01&per_page=15" \
  --jq '.items[].pull_request.url' | head -15 | while read url; do
    REPO=$(echo "$url" | sed -E 's|.*repos/||;s|/pulls/.*||')
    NUM=$(echo "$url" | sed -E 's|.*/||')
    gh api "repos/$REPO/pulls/$NUM/reviews" --paginate \
      --jq ".[] | select(.user.login==\"$USERNAME\" and .body != \"\") | {body, url: .html_url}" 2>/dev/null
    sleep 0.2
done
```

## Source 2: user-provided text

If the user pastes samples of their writing, use those too. Emails, Slack messages, prior documents, and review comments are often more representative of non-technical voice.

Ask:

> Want to paste any examples of your writing? Emails, Slack messages, documents — anything that sounds like you. This helps me match your tone.

## Source 3: local files

If the user has Markdown files, READMEs, or documents they wrote:

```bash
# Find authored Markdown files in the current repository
git log --author="$USERNAME" --diff-filter=A --name-only --pretty=format: -- '*.md' | head -10
```

## Building the voice profile

Look for:

| Dimension | What to look for | Examples |
|-----------|-----------------|----------|
| Sentence length | Short and punchy? Long and flowing? Mixed? | "Fixed it." vs "I went through the logs and traced the issue back to..." |
| Formality | Contractions? First person? Casual openers? | "I'll fix this" vs "This will be addressed" |
| Structure | Bullets? Numbered lists? Headers? Dense paragraphs? | Some people always use bullets; others never do |
| Vocabulary | Technical depth? Jargon? Plain language? | "We need to shard the index" vs "We need to split the data" |
| Tone | Direct? Diplomatic? Enthusiastic? Dry? | Exclamation points, hedging, assertions |
| Openers | How messages start | "Quick update" / "Context:" / just diving in |
| Closers | How messages end | "LMK" / "Thoughts?" / "Thanks" / no closer |
| Emoji | Never? Sparingly? Frequently? | Match the user's actual usage |
| Transitions | How ideas connect | "Also," / "On a related note," / "Re:" / no transitions |
| Signature patterns | Recurring habits | Section headers, context first, ending with a question |

Store sampled profiles as short structured notes: one line per dimension, sample phrases that sound like the user, and things they never do. Do not store raw samples.

## When not to sample

- Do not sample bot-generated content.
- Do not sample text from repositories that produce mostly automated content.
- Do not sample very short comments under 100 characters.
- Do not sample text that is clearly copied from documentation or templates.
- Do not sample these skill files or the curated profile; they are instructions, not voice samples.

## Silent by default

Do not show the user the voice analysis unless they ask. Just use it when writing. If they say "this doesn't sound like me," reference the profile and ask what to adjust.

## Voice profile caching

Cache sampled profiles so they persist across sessions. Sampled profiles only: never the curated profile, never raw samples.

```bash
PROFILE="$HOME/.pi/voice-profiles/${USERNAME}.md"
mkdir -p "$(dirname "$PROFILE")"
[ -f "$PROFILE" ] && cat "$PROFILE"
# Otherwise write it with a `# Generated: YYYY-MM-DD` header.
# Regenerate if it is older than 90 days or the user says the voice does not match.
```
