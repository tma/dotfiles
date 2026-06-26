---
name: writing-voice
description: Write drafts in the user's voice for comments, docs, messages, reviews, and release notes.
---

# Writing Voice

Use this for any personal writing where the reader should think the user wrote it themselves: performance reviews, status updates, emails, proposals, design documents, blog posts, Slack drafts, GitHub comments, reviews, release notes, and commit messages.

This skill has two parts:

1. Voice profile: match how the user actually writes.
2. Style rules: avoid patterns that make text sound AI-generated.

Before drafting, read:

- `references/tma-curated-voice.md` for tma's baseline voice.
- `references/style-rules.md` for kill-list words, filler, punctuation, and structure rules.

Read `references/voice-sampling.md` only when there is no curated/cached profile, the user asks for sampling, the current draft does not sound like them, or the curated profile needs more signal for the format.

## Skill-local curated profile

For tma, `references/tma-curated-voice.md` is the committed, sanitized baseline voice. Use it before sampling recent writing or cache files. Sampled profiles are supplemental signal, never a replacement.

Keep the curated profile style-only: no raw samples, internal links, teammate names, or private details. Do not overwrite it with sampled content; edit it by hand.

## Application workflow

1. Load the curated profile first.
2. Load the style rules.
3. If needed, load sampled profile notes from `$HOME/.pi/voice-profiles/` or collect samples using `references/voice-sampling.md`.
4. Draft the text.
5. Edit once for voice: direct, plainspoken, specific, and appropriate to the venue.
6. Edit once for AI tells: kill-list words, filler, em-dash overuse, dramatic fragments, and generic conclusions.
7. Return or publish only after the final checklist passes.

## Default style target

If no profile is available, write in a direct, specific, confident-not-arrogant style:

- Use contractions unless the format is unusually formal.
- Lead with the point, then add context.
- Prefer concrete nouns and plain verbs.
- Keep paragraphs short.
- Cut filler before polishing.
- Ask for missing names, numbers, dates, or links instead of inventing them.

## Rules

1. **Curated profile first** — for tma, use `references/tma-curated-voice.md` as the baseline.
2. **Sample only when needed** — sample before writing only when no curated/cached profile exists, the user asks, the profile does not fit, or more signal is needed.
3. **Use sampled signal as supplemental** — never let sampled notes override the curated profile for tma.
4. **Never show the profile unprompted** — use it silently; share only if asked.
5. **Kill-list words are absolute** — replace them even if the user uses them.
6. **Style beats voice for bad patterns** — copy good habits, not AI-sounding ones.
7. **Specifics beat polish** — when in doubt, make it shorter and more concrete.
8. **Keep profiles separate** — curated profile in the skill folder; sampled profiles in `~/.pi/voice-profiles`; refresh sampled profiles quarterly.

## Final edit checklist

Before returning prose, check:

- Does this sound like something tma would say to a colleague?
- Is the ask or point clear in the first few lines?
- Are the important details preserved?
- Did any AI-tell words, structures, or em-dash overuse slip in?
- Is it too polished for the context?
- Can any sentence be cut without losing meaning?
