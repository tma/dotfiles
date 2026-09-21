---
name: design-review
description: Stress-test a design decision the user brings, and compare alternatives before they commit to one.
disable-model-invocation: true
---

# Design Review

Invoke with `/skill:design-review`. This skill is user-invoked only: it never fires on its own, and it is not a step before ordinary coding. Reach for it when a decision is ambiguous, expensive to reverse, or one the user wants pushed on.

The output is a shared understanding in the conversation. It does not authorize implementing, committing, or publishing anything.

## 1. Pin down the decision

Get one sentence for what is being decided and one for what is out of scope. "Where should retry state live" is a decision. "Make the sync better" is not; narrow it before continuing.

Also establish what would make one answer better than another: the constraints that actually bind (compatibility, deadline, team size, data volume, an interface that cannot change), and the outcome the user is optimizing for.

**Done when:** you can state the decision, its boundaries, and the constraint that most limits the options.

## 2. Find the facts yourself

Anything discoverable is your job, not the user's. Read the code, the configuration, the schema, the tests, the dependency versions, the call sites. Ask the user only about intent, priorities, and things the repository cannot tell you: roadmap, upcoming load, team preference, what broke last time.

Use the repository's own vocabulary throughout. Adopt the names the code and the team already use rather than introducing a parallel glossary.

If gathering facts is substantial, delegate read-only exploration and continue with the questions that do not depend on it.

**Done when:** no open question is one you could have answered by reading the repository.

## 3. Work the questions in rounds

Group the decisions that are independent of each other and ask them together. Hold back any question whose answer depends on one still open: it belongs in the next round.

For each question: a short title, the options with their consequences, and your recommended answer. Recommend; do not present a neutral menu.

```
❓ **Q1 — <title>**: <the question, with the options and what each one costs>

➡️ <your recommendation and why>
```

Keep rounds bounded. Two or three rounds is usually enough. Stop when the remaining questions no longer change the decision, and say so rather than continuing for completeness. An exhaustive interview is not the goal.

**Done when:** every open question either has an answer, is explicitly deferred, or is recorded as an unknown that the design must tolerate.

## 4. Compare alternatives when the decision warrants it

For consequential or genuinely ambiguous choices, read the [alternative designs reference](./references/alternative-designs.md) and run a comparison. For smaller decisions, reason through the options yourself; the comparison is a tool, not a required step.

## 5. Close the session

Summarize in the conversation:

- **Settled** — each decision and the reason it went that way.
- **Deferred** — decisions parked on purpose, and what would reopen them.
- **Unknown** — what nobody could answer, and how the design tolerates being wrong about it.
- **Risks** — what this design makes hard later, and what it makes easy.

Do not write an architecture decision record, a design document, or any other file unless the user asks for one. When they do, it is a project artifact: write it in their voice, in the place the project keeps such documents.

Ending here is the normal outcome. Implementation is a separate request.

---

Adapted from Matt Pocock's `grilling` and `codebase-design` skills. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
