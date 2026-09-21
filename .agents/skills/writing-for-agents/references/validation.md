# Validation checklist

Read this before finishing an edit to a skill, a reference file, or agent instructions.

## Behavior preservation

Run through the document you changed, old version beside new:

- [ ] Every rule the old version stated is either still stated or deliberately dropped with a reason you can give the user.
- [ ] Every safety gate survived: approvals before publishing or destructive actions, read-only constraints, credential and personal-data redaction, tool restrictions, staging precision, branch protection.
- [ ] Moved rules kept their strength. A requirement that became a suggestion is a regression, not a cleanup.
- [ ] Pointers the agent must follow before acting read as obligations, not options, and name what breaks if skipped. The wording carries this, not a particular keyword.
- [ ] Commands still run as written: no swallowed errors (`2>/dev/null || true` around a call whose failure matters), no invented flags, no placeholder that looks like a real value.
- [ ] Examples use generic placeholders: `owner/repo`, `example.com`, `$HOME`, `user@example.com`.

## Structural checks

Use the target repository's existing checks where available: its linting,
formatting, or link checker. Run the narrowest relevant command and report any
checks you could not run. Do not assume another repository has this collection's
tooling or add a test suite just to validate a prose edit.

Check these manually or with available tooling:

- Skill names and descriptions satisfy the [frontmatter rules](./skill-mechanics.md), and names match their directories without collisions.
- Relative links resolve from the file containing them, including attribution links.
- Every reference has a clear loading condition; required reads remain obligations.
- Shell examples parse with the appropriate shell's syntax checker, such as `bash -n`. Syntax checks do not prove the commands work; use safe local examples when practical, never live mutations just to validate documentation.

These checks catch structural mistakes, not whether a model follows the document.
Keep the manual scenarios below.

## Manual scenarios

Structural checks cannot tell you whether the instructions work. Walk the changed skill through these scenarios by reading it as the agent would:

1. **Ordinary task, no trigger.** A request in the same area that should *not* load this skill. Does the description keep it out of the way?
2. **Targeted trigger.** The request the skill exists for. Does the first screen give the agent the whole routine path, or does it have to guess which reference to read?
3. **Ambiguity.** Input that matches two branches, or a scope the user left open. Does the document say which branch wins or which question to ask?
4. **Missing tooling.** The CLI is not installed, authentication is missing, or the input is empty. Does the document say to stop and report, rather than fake a result?
5. **Safety.** The path where the agent could publish, delete, rewrite history, or leak a credential. Is the gate visible at that point without following a pointer?
6. **Optional references.** For each reference, can you name the request that triggers it? A reference nothing triggers is either dead or belongs inline.

Note the scenarios you walked and anything you could not resolve. Unresolved ambiguity is worth reporting; a document that quietly covers it up is not.
