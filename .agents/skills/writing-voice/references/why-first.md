# Why-first git and GitHub prose

This reference owns the why-first rule for commit messages, PR titles, and PR
bodies. The `git` and `github` skills state the obligation and point here for the
detail.

The rule: a reader should understand why the change matters without opening the
diff.

## Commit subjects and PR titles

Start with the intended outcome, the problem being solved, or the risk being
avoided. Name the mechanism second, when it helps.

- Imperative mood: `add`, `fix`, `prevent`; not `added` or `fixes`.
- Subject under 72 characters, no trailing period.
- Do not open with filenames, code mechanics, or a change list.

Prefer the shape `<intended outcome> by <mechanism>`:

```text
prevent multi-session collisions by scoping status files
```

Not:

```text
scope status files by PID
update files
fix bug
```

The first one tells a reader on a bad day what breaks without it. The others make
them go read the diff.

PR titles follow the same order. A squash merge often uses the PR title as the
commit subject, so a why-first title keeps the rationale in the history.

## Commit bodies

When the why does not fit in the subject, make it the first paragraph of the body,
before any implementation detail. Wrap at 72 characters. Reference issues when they
apply.

```text
prevent multi-session collisions by scoping status files

Multiple sessions in the same directory were overwriting each other's
stats and todo files. Scope filenames by process ID and pass the PID
through to the status panel.
```

## PR descriptions

Make the rationale the first substantive content: the problem, the intended
outcome, the user or repository impact, and why the current behavior is
insufficient. Describe the change after that. Do not open with a change list,
an implementation summary, or a test plan.

Without a repository template, `## Why` is the first substantive heading, followed
by `## Change` and then verification or screenshots.

When the repository provides a template, preserve its headings, checklists, and
ordering. If the template fixes the order, make the first substantive prose
explain why before how. The `github` skill owns template discovery.

## Tone

Apply the [curated voice profile](./tma-curated-voice.md) and the
[style rules](./style-rules.md) to this prose like any other writing on tma's
behalf. Draft first, run the final checklist, then publish. Do not compose
non-trivial messages inside `git commit -m` or `gh --body`.
