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

For tma, first read `references/tma-curated-voice.md` from this skill directory.
That file is the committed, sanitized baseline voice profile. Use it as the
stable target before sampling recent writing or reading generated cache files.

The curated profile should contain style guidance only: no raw writing samples,
internal links, teammate names, private project details, or copied private text.
Never overwrite it with automatically sampled content. Update it by hand when the
user wants to change the standing voice guidance.

Use generated or sampled profiles as supplemental signal, not as a replacement
for the curated profile.

---

## Voice Sampling

When no curated or cached profile exists, sample the user's real writing to build
a voice profile. The more samples, the better the match. For tma, use the
skill-local curated profile first, then sample only when additional signal is
needed.

### Source 1: GitHub activity (automatic)

Pull the user's writing from GitHub — PR descriptions, issue comments, review
comments, discussion posts. These are unpolished and natural, which makes them
ideal voice samples.

```bash
# Detect username
USERNAME=$(gh auth status 2>&1 | grep "Logged in to github.com as" | sed 's/.*as //' | sed 's/ .*//')

# Pull their 15 longest PR descriptions (rich, substantive writing)
# Use 2025 or earlier to sample pre-AI-era voice, not recent AI-assisted writing
gh search prs --author="$USERNAME" --owner=owner --created=<2026-01-01 --limit=50 \
  --json url,title,body | python3 -c "
import sys, json
prs = json.load(sys.stdin)
prs = [p for p in prs if p.get('body') and len(p['body']) > 150]
prs.sort(key=lambda p: len(p['body']), reverse=True)
for p in prs[:15]:
    print(json.dumps({'type': 'pr-description', 'url': p['url'], 'body': p['body']}))
"

# Pull their 15 longest issue/PR comments (2025 or earlier)
gh api "search/issues?q=commenter:$USERNAME+org:owner+created:<2026-01-01+sort:updated&per_page=20" \
  --jq '.items[].url' | head -20 | while read url; do
    # Extract owner/repo/number from URL
    PARTS=$(echo "$url" | sed 's|https://api.github.com/repos/||' | sed 's|/issues/| |' | sed 's|/pulls/| |')
    REPO=$(echo "$PARTS" | awk '{print $1}')
    NUM=$(echo "$PARTS" | awk '{print $2}')
    gh api "repos/$REPO/issues/$NUM/comments" --paginate \
      --jq ".[] | select(.user.login==\"$USERNAME\") | {type: \"comment\", body: .body, url: .html_url}" 2>/dev/null
    sleep 0.2
done | python3 -c "
import sys, json
comments = [json.loads(line) for line in sys.stdin if line.strip()]
comments = [c for c in comments if len(c.get('body','')) > 100]
comments.sort(key=lambda c: len(c['body']), reverse=True)
for c in comments[:15]:
    print(json.dumps(c))
"

# Pull their review comments (shows technical voice, 2025 or earlier)
gh api "search/issues?q=reviewed-by:$USERNAME+org:owner+type:pr+created:<2026-01-01+sort:updated&per_page=15" \
  --jq '.items[].pull_request.url' | head -15 | while read url; do
    PARTS=$(echo "$url" | sed 's|https://api.github.com/repos/||' | sed 's|/pulls/| |')
    REPO=$(echo "$PARTS" | awk '{print $1}')
    NUM=$(echo "$PARTS" | awk '{print $2}')
    gh api "repos/$REPO/pulls/$NUM/reviews" --paginate \
      --jq ".[] | select(.user.login==\"$USERNAME\" and .body != \"\") | {type: \"review\", body: .body, url: .html_url}" 2>/dev/null
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

Store the profile as structured text:

```
Voice profile for @username
===========================
Sentence style: [short/mixed/long]
Formality: [casual/professional/formal]
Structure preference: [bullets/paragraphs/headers/mixed]
Tone: [direct/diplomatic/enthusiastic/dry]
Emoji usage: [never/rare/moderate/frequent]
Openers: [describe pattern]
Closers: [describe pattern]
Notable patterns: [specific observations]
Sample phrases that sound like them: ["...", "...", "..."]
Things they never do: [e.g., never uses exclamation points, never starts with "I"]
```

### When NOT to sample

- Don't sample bot-generated content (automated PR descriptions, template-filled issues)
- Don't sample text from repos that produce mostly automated content
- Don't sample very short comments (< 100 chars) — too little signal
- Don't sample text that's clearly copy-pasted from docs or templates

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

### Structural patterns that scream AI

Avoid these like the plague:

**1. Self-answering rhetorical questions**
Bad: "The result? A 40% improvement in deployment speed."
Better: "Deployment speed improved 40%."

**2. Fragment strings for dramatic effect**
Bad: "Shipping code. Building trust. Changing the game."
This is the single most common AI writing pattern. Never do this.

**3. Tacking on empty analysis**
Bad: "...highlighting the importance of collaboration in modern software development."
If the reader can't learn anything new from the sentence, cut it.

**4. Starting every paragraph the same way**
Bad: "I also..." / "Additionally,..." / "Furthermore,..." repeating
Vary your openings. Start some paragraphs with the subject, some with context, some mid-thought.

**5. One-sentence paragraphs for emphasis (repeated)**
One is fine occasionally. Three in a row is an AI tell.

**6. Restating the same point in different words**
Bad: "This improved reliability. The system became more dependable. Users experienced fewer outages."
Pick the strongest version. Say it once.

**7. The "not only X but also Y" construction**
Bad: "This not only improved performance but also enhanced the developer experience."
Overused by LLMs. Just say both things plainly.

**8. Ending with a grand takeaway**
Bad: "This experience reinforced the importance of clear communication and collaborative problem-solving."
If your examples are good, the reader gets the point. Don't explain the moral.

**9. Numbered or bulleted lists of abstract qualities**
Bad: "Key qualities I demonstrated: 1) Leadership 2) Communication 3) Technical excellence"
Show these through examples, don't list them.

**10. The mirror structure (problem → action → result, repeated identically)**
Varying your narrative structure makes writing feel human. Not everything needs to be a case study.

### What to do instead

**Be specific.** Every sentence should contain at least one of: a name, a number, a link, a date, or a concrete detail. If it doesn't, it's probably filler.

**Lead with outcomes.** What shipped or changed, then how. Not the other way around.

**Use the user's real words.** If they described something in a PR or comment, pull that language in. Their phrasing is better than a polished rewrite.

**Mix sentence lengths.** Short sentences create punch. Longer ones provide context and flow. Alternating feels natural. Three short sentences in a row feels choppy. Three long ones feels dense.

**Show, don't label.** Don't write "I demonstrated leadership." Describe what you did and let the reader see it. Don't write "I showed growth mindset." Describe what you learned and how you changed.

**Contractions are fine.** "I've" beats "I have" in anything short of a legal document. Match the formality of the context.

**Keep paragraphs to 3-5 sentences.** Walls of text signal no editing happened. Very short paragraphs signal AI-generated structure.

---

## Applying Voice + Style Together

When generating text for someone:

1. **If a skill-local curated profile exists**: read it first and match that stable guidance. For tma, use `references/tma-curated-voice.md` as the baseline.

2. **If a generated or sampled voice profile exists**: use it as supplemental signal. Match reliable patterns from the samples, but do not let generated analysis override the curated profile.

3. **If no voice profile exists**: default to direct, specific, and confident without being arrogant. Mix short and long sentences. Use contractions. Write like you'd explain something to a smart colleague over coffee.

4. **After generating**: scan the output for kill-list words and AI patterns. Fix any that slipped through. Read it out loud in your head — if any sentence sounds like it came from a chatbot, rewrite it.

### The coffee test

For any sentence, ask: "Would this person actually say this to a colleague over coffee?"

- "I spearheaded a cross-functional initiative to streamline our deployment pipeline" → No
- "I led the work to speed up deploys — got Billing and Infra to agree on the new config" → Yes

If it fails the coffee test, rewrite it.

---

## Voice Profile Caching

When a voice profile is built, cache it so it persists across sessions:

```bash
PROFILE_DIR="$HOME/.pi/voice-profiles"
mkdir -p "$PROFILE_DIR"
# Write profile
cat > "$PROFILE_DIR/${USERNAME}.md" << 'EOF'
# Voice profile for @username
# Generated: YYYY-MM-DD
# Sources: N PR descriptions, N comments, N reviews

Sentence style: mixed
Formality: professional-casual
...
EOF
```

On subsequent sessions, check for an existing profile:
```bash
PROFILE="$HOME/.pi/voice-profiles/${USERNAME}.md"
if [ -f "$PROFILE" ]; then
    cat "$PROFILE"
fi
```

Regenerate if the user says the voice doesn't match, or if the profile is > 90 days old.

Generated cache files are for sampled analysis only. Do not use them to store the
skill-local curated profile, and do not write raw samples into the skill folder.

---

## Rules

1. **Use the curated profile first** — for tma, read `references/tma-curated-voice.md` before drafting.
2. **Sample before writing when no profile exists** — if writing for someone and no curated or cached voice profile exists, try to pull samples first. Even 3-5 samples help.
3. **Never show the profile unprompted** — just use it silently. Only share if the user asks.
4. **Kill-list words are absolute** — never use them regardless of voice profile. Even if the user uses "leverage" themselves, find a better word.
5. **Style rules override voice for bad patterns** — if the user writes in AI-sounding patterns naturally, don't copy those patterns. Copy their good habits.
6. **Specifics beat polish** — a rough sentence with a real detail beats a smooth sentence with none.
7. **When in doubt, shorter** — most AI text is too long. Cut aggressively. Every sentence should earn its place.
8. **Cache sampled voice profiles** — don't re-sample every session. Build once, reuse, refresh quarterly.
9. **Keep curated and sampled profiles separate** — curated profiles live in the skill folder; generated sampled profiles live in `~/.pi/voice-profiles`.
10. **Multiple sources are better** — PR descriptions show technical voice, comments show conversational voice, reviews show evaluative voice. Sample all three.
