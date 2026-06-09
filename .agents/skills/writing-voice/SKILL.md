---
name: writing-voice
description: Write drafts in the user's voice for comments, docs, messages, reviews, and release notes.
---

# Writing Voice — Sound Like a Human, Not a Model

This skill does two things:
1. **Voice sampling** — analyze the user's real writing to learn how they sound
2. **Style rules** — avoid patterns that make text obviously AI-generated

Use this for any personal writing: performance reviews, status updates, emails,
proposals, design docs, blog posts, Slack drafts, or anything where the reader
should think the user wrote it themselves.

---

## Skill-Local Curated Profile

For tma, read `references/tma-curated-voice.md` first. It is the committed,
sanitized baseline voice — the stable target before sampling recent writing or
cache files. Sampled profiles are supplemental signal, never a replacement.

Keep it style guidance only: no raw samples, internal links, teammate names, or
private details. Don't overwrite it with sampled content; edit it by hand.

---

## Voice Sampling

When no curated or cached profile exists, sample the user's real writing — more
samples, better match. For tma, sample only when the curated profile needs more
signal.

### Source 1: GitHub activity (automatic)

Pull unpolished, natural writing: PR descriptions, issue/PR comments, reviews.
Sample 2025 or earlier to avoid recent AI-assisted text. Replace `owner` with the org.

```bash
USERNAME=$(gh api user --jq .login)   # authenticated user (robust across gh versions)

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

# Review bodies (technical/evaluative voice)
gh api "search/issues?q=reviewed-by:$USERNAME+org:owner+type:pr+created:<2026-01-01&per_page=15" \
  --jq '.items[].pull_request.url' | head -15 | while read url; do
    REPO=$(echo "$url" | sed -E 's|.*repos/||;s|/pulls/.*||')
    NUM=$(echo "$url" | sed -E 's|.*/||')
    gh api "repos/$REPO/pulls/$NUM/reviews" --paginate \
      --jq ".[] | select(.user.login==\"$USERNAME\" and .body != \"\") | {body, url: .html_url}" 2>/dev/null
    sleep 0.2
done
```

### Source 2: User-provided text

If the user pastes samples of their writing (emails, Slack messages, prior docs),
use those too. They're often more representative of non-technical voice.

Ask: "Want to paste any examples of your writing? Emails, Slack messages, docs —
anything that sounds like you. This helps me match your tone."

### Source 3: Local files

If the user has markdown files, READMEs, or docs they've written:
```bash
# Find their authored markdown files in the current repo
git log --author="$USERNAME" --diff-filter=A --name-only --pretty=format: -- '*.md' | head -10
```

### Building the voice profile

Analyze 10-20 samples across sources. Look for:

| Dimension | What to look for | Examples |
|-----------|-----------------|----------|
| **Sentence length** | Short and punchy? Long and flowing? Mixed? | "Fixed it." vs "I went through the logs and traced the issue back to..." |
| **Formality** | Contractions? First person? Casual openers? | "I'll fix this" vs "This will be addressed" |
| **Structure** | Bullets? Numbered lists? Headers? Dense paragraphs? | Some people always use bullets; others never do |
| **Vocabulary** | Technical depth? Jargon? Plain language? | "We need to shard the index" vs "We need to split the data" |
| **Tone** | Direct? Diplomatic? Enthusiastic? Dry? | Exclamation points, hedging ("I think maybe"), assertions ("This is wrong") |
| **Openers** | How do they start messages? | "Quick update —" / "Hey!" / "Context:" / Just diving in |
| **Closers** | How do they end? | "LMK" / "Thoughts?" / "Thanks!" / No closer at all |
| **Emoji** | Never? Sparingly? Frequently? | Some people use 🎉 liberally; others never |
| **Transitions** | How they connect ideas | "Also," / "On a related note," / "Re:" / No transitions |
| **Signature patterns** | Recurring habits | Always bold section headers, always lead with context, always end with a question |

Store the profile as short structured notes — one line per dimension above, plus
sample phrases that sound like them and things they never do (e.g. never uses
exclamation points).

### When NOT to sample

- Don't sample bot-generated content (automated PR descriptions, template-filled issues)
- Don't sample text from repos that produce mostly automated content
- Don't sample very short comments (< 100 chars) — too little signal
- Don't sample text that's clearly copy-pasted from docs or templates
- Don't sample these skill files or the curated profile — they're instructions, not voice samples

### Silent by default

Do NOT show the user the voice analysis unless they ask. Just use it when writing.
If they say "this doesn't sound like me," reference the profile and ask what to adjust.

---

## Style Rules — Avoiding AI-Generated Patterns

These rules apply to ALL personal writing, regardless of whether a voice profile exists.

### Words to never use

These are AI-generated-text tells. Anyone who reads a lot of LLM output will spot them instantly.

**Kill list:**
- "delve" / "delving"
- "synergy" / "synergize"
- "leverage" (as a verb)
- "robust"
- "streamline"
- "harness"
- "utilize" (just say "use")
- "spearheaded"
- "orchestrated"
- "fostered"
- "champion" (as a verb)
- "holistic"
- "passion" / "passionate"
- "thoughtful approach"
- "pivotal"
- "cutting-edge"
- "game-changer"
- "paradigm"
- "synergistic"
- "endeavor"
- "bolster"
- "facilitate"
- "seamless" / "seamlessly"
- "landscape" (when not talking about actual land)
- "navigate" (when not talking about actual navigation)
- "empower" / "empowering"
- "elevate"

**Replacements:**
| Instead of | Say |
|-----------|-----|
| "stakeholders" | who specifically — "the billing team", "our PM" |
| "cross-functional" | which teams — "worked with Billing and Trust & Safety" |
| "serves as" / "stands as" | "is" |
| "leverage" | "use" |
| "utilize" | "use" |
| "facilitate" | "run" / "help with" / "set up" |
| "streamline" | "simplify" / "speed up" / "cut steps from" |
| "spearheaded" | "led" / "started" / "built" |
| "orchestrated" | "coordinated" / "ran" |
| "robust" | "solid" / "reliable" / describe what makes it good |
| "fostered" | "built" / "encouraged" / "created" |
| "endeavor" | "project" / "work" / "effort" |

### Filler phrases to drop entirely

These add zero information. Delete them:
- "It's worth noting that"
- "Importantly,"
- "Notably,"
- "It bears mentioning"
- "It should be noted"
- "In today's [anything]"
- "At the end of the day"
- "When it comes to"
- "In terms of"
- "As a matter of fact"
- "Moving forward"
- "Going forward"
- "All in all"

### Punctuation tells

- **Em-dashes** are the loudest current AI tell. Use them sparingly (a couple per page, not one per sentence); prefer a comma, period, or parentheses for most asides.
- Don't stack them with the patterns below, like fragment strings (#2) or self-answering questions (#1). The combination reads as machine-written.

### Structural patterns that scream AI

Avoid these:

1. **Self-answering rhetorical questions.** Not "The result? Deploys got 40% faster" — just state it.
2. **Fragment strings for drama.** "Shipping code. Building trust. Changing the game." Never.
3. **Empty analysis tacked on** ("...highlighting the importance of collaboration"). Cut it.
4. **Same opener every paragraph** ("I also... Additionally... Furthermore..."). Vary openings.
5. **Repeated one-sentence paragraphs.** One is fine; three in a row is a tell.
6. **Restating one point three ways.** Pick the strongest, say it once.
7. **"Not only X but also Y."** Just say both things plainly.
8. **Grand closing takeaway** ("This reinforced the importance of..."). Let examples speak.
9. **Lists of abstract qualities** ("Leadership, Communication, Technical excellence"). Show, don't list.
10. **Identical problem → action → result mirror.** Vary the structure.

### What to do instead

- **Be specific.** Every sentence needs a name, number, link, date, or concrete detail, or it's filler. Never invent them — if a name, number, date, or link isn't given, ask or leave a placeholder.
- **Lead with outcomes** — what shipped or changed, then how.
- **Use the user's real words** from their PRs/comments over a polished rewrite.
- **Mix sentence lengths.** Short for punch, long for context; avoid three of either in a row.
- **Show, don't label.** Describe what was done, not "I demonstrated leadership."
- **Contractions are fine.** Match the format's formality.
- **Paragraphs 3-5 sentences.** Walls of text or strings of one-liners both signal no editing.

---

## Applying Voice + Style Together

1. **Curated profile exists** (tma → `references/tma-curated-voice.md`): match it as the baseline.
2. **Sampled profile exists**: supplemental signal only; don't let it override the curated profile.
3. **No profile**: direct, specific, confident-not-arrogant; mixed sentence lengths; contractions.
4. **After generating**: scan for kill-list words and AI patterns; read it back and rewrite anything that sounds like a chatbot.

**Coffee test** — would this person say this to a colleague over coffee? If not, rewrite it.
- "I spearheaded a cross-functional initiative to streamline our deployment pipeline" → No
- "I led the work to speed up deploys — got Billing and Infra to agree on the new config" → Yes

---

## Voice Profile Caching

Cache built profiles so they persist across sessions. Sampled profiles only —
never the curated profile, never raw samples.

```bash
PROFILE="$HOME/.pi/voice-profiles/${USERNAME}.md"   # sampled profiles live here
mkdir -p "$(dirname "$PROFILE")"
[ -f "$PROFILE" ] && cat "$PROFILE"                  # reuse if present
# else write it with a `# Generated: YYYY-MM-DD` header.
# Regenerate if > 90 days old or the user says the voice doesn't match.
```

---

## Rules

1. **Curated profile first** (tma → `references/tma-curated-voice.md`), then sampled signal.
2. **Sample before writing** when no profile exists — even 3-5 samples help.
3. **Never show the profile unprompted** — use it silently; share only if asked.
4. **Kill-list words are absolute** — replace them even if the user uses them.
5. **Style beats voice for bad patterns** — copy good habits, not AI-sounding ones.
6. **Specifics beat polish; when in doubt, shorter.** Cut aggressively.
7. **Keep profiles separate** — curated in the skill folder, sampled in `~/.pi/voice-profiles`; refresh quarterly.
8. **Sample all three sources** — PR descriptions (technical), comments (conversational), reviews (evaluative).
