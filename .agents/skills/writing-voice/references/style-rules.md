# Style rules

These rules apply to all personal writing, regardless of whether a voice profile exists.

## Words to never use

These are common AI-generated-text tells. Replace them even if a first draft uses them.

Kill list:

- "delve" / "delving"
- "synergy" / "synergize"
- "leverage" as a verb
- "robust"
- "streamline"
- "harness"
- "utilize"
- "spearheaded"
- "orchestrated"
- "fostered"
- "champion" as a verb
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
- "landscape" when not talking about actual land
- "navigate" when not talking about actual navigation
- "empower" / "empowering"
- "elevate"

Replacements:

| Instead of | Say |
|-----------|-----|
| "stakeholders" | who specifically: "the billing team", "our PM" |
| "cross-functional" | which teams: "worked with Billing and Trust & Safety" |
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

## Filler phrases to drop

Delete these:

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

## Punctuation tells

- Em dashes are a current AI tell. Use them sparingly, at most a couple per page. Prefer a comma, period, or parentheses for most asides.
- Do not stack em dashes with fragment strings or self-answering questions.

## Structural patterns to avoid

1. Self-answering rhetorical questions. Not "The result? Deploys got 40% faster." Just state it.
2. Fragment strings for drama. "Shipping code. Building trust. Changing the game." Never.
3. Empty analysis tacked on, such as "highlighting the importance of collaboration." Cut it.
4. Same opener every paragraph: "I also... Additionally... Furthermore..." Vary openings.
5. Repeated one-sentence paragraphs. One is fine; three in a row is a tell.
6. Restating one point three ways. Pick the strongest and say it once.
7. "Not only X but also Y." Just say both things plainly.
8. Grand closing takeaway. Let examples speak.
9. Lists of abstract qualities like "Leadership, Communication, Technical excellence." Show, do not label.
10. Identical problem/action/result mirror. Vary the structure.

## What to do instead

- Be specific. Every sentence needs a name, number, link, date, or concrete detail, or it is filler. Never invent details.
- Lead with outcomes: what shipped or changed, then how.
- Use the user's real words from their PRs/comments over a polished rewrite.
- Mix sentence lengths. Short for punch, long for context.
- Show, do not label. Describe what was done, not "I demonstrated leadership."
- Contractions are fine. Match the format's formality.
- Keep paragraphs to 3–5 sentences for most writing.

## GitHub Markdown links

When drafting GitHub-facing Markdown, including issue bodies, PR bodies, discussions, comments, and reviews, let GitHub autolink issue and PR references.

- Use bare GitHub issue and PR URLs, especially in bullet lists.
- Do not write Markdown links like `[owner/repo#123](https://github.com/owner/repo/issues/123)`.
- Do not put issue or PR references in backticks.

## Applying voice and style together

1. Curated profile exists: for tma, read the [curated voice profile](./tma-curated-voice.md) and match it as the baseline.
2. Sampled profile exists: use it as supplemental signal only; do not let it override the curated profile.
3. No profile exists: write in a direct, specific, confident-not-arrogant style with mixed sentence lengths and contractions.
4. After generating: scan for kill-list words and AI patterns. Rewrite anything that sounds like a chatbot.

Coffee test: would this person say this to a colleague over coffee? If not, rewrite it.

No:

> I spearheaded a cross-functional initiative to streamline our deployment pipeline.

Yes:

> I led the work to speed up deploys. Billing and Infra agreed on the new configuration.
