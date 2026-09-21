# Long-form drafting

Read this for writing that runs longer than a few paragraphs: a blog post, a
design document, a detailed proposal, an incident writeup, a long status update.
For short replies, comments, and commit messages, the main `writing-voice` skill
is enough; this overhead is not worth it there.

The curated voice profile and style rules still apply. This adds structure for
material long enough that a reader can get lost in it.

## 1. Establish what the reader already knows

Before drafting, settle two things with the user:

- **Audience** — who reads this, and what they already know walking in.
- **Prerequisites** — the concepts you can use from the first sentence without
  explaining them.

Get this wrong in either direction and the draft fails: assume too much and the
reader is lost by paragraph three, explain too much and the piece drowns in
definitions before it says anything.

Ask only when the request leaves it open. When the user already named the
audience, the venue, or the readers' background, take it from there and say what you
assumed. One question is enough when you do need it: "Writing this for people who
already know X, or do I need to introduce it?"

## 2. Ground concepts before leaning on them

Every concept the piece depends on is either a prerequisite the reader brought or
something an earlier section established. A paragraph that leans on an idea the
reader has not met yet loses them, even when the jargon is absent.

Keep a running list while drafting. When the next point needs a concept that is
not grounded yet, that concept is the next thing to write: introduce it where it
first matters, with the shortest example that makes it real.

Where a concept has a name the reader will see again, introduce the idea and the
name together, then use that name consistently. Do not rotate synonyms.

## 3. Draft in order, in full

Write the whole draft, in reading order, and show it to the user. Do not stop
after each paragraph for approval; that turns a 20-minute draft into an hour of
turn-taking and usually produces worse structure, because nobody can see the shape
until it exists.

While drafting, make the format choices deliberately:

- **Prose or list** — prose carries an argument, lists carry parallel items. If the
  items are not genuinely parallel, prose is better.
- **Table or repeated structure** — a table once the same fields repeat three or
  more times.
- **Quote or paraphrase** — quote when the exact wording is the point.
- **Code block or inline** — blocks for anything multi-line or runnable.
- **Callout or inline** — a callout only for something that would genuinely derail
  the main line of the argument.

## 4. Revise against the opening

The opening sets a promise. Read the draft once against it: does every section
deliver on it, and does the piece still end where the opening pointed? If it
drifted somewhere better, rewrite the opening rather than bending the body back.

Then the usual passes: the [style rules](./style-rules.md) for AI tells, and the
final checklist in the main skill.

## 5. Preserve the user's edits

Long pieces get edited between turns. When you return to a draft:

- Re-read the current file or message before changing it. Never write over a
  version you have not just read.
- When the user rewrote a passage, keep their wording. Their sentence is the voice
  target; do not "improve" it back toward your draft.
- When asked to change one section, change that section and leave the rest alone.
- If their edit conflicts with something else in the piece, point at the conflict
  and ask, rather than silently reconciling it.

## What not to do

- Do not create working files, outlines, or fragment collections that live on past
  the task. Draft in the conversation or in the document the user named. The
  `context-memory` skill owns that policy.
- Do not add frontmatter, metadata, or platform formatting the user did not ask
  for.
- Do not invent names, numbers, dates, links, or quotes. Ask for what is missing.

---

Adapted from Matt Pocock's in-progress `writing-shape` skill. See
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
