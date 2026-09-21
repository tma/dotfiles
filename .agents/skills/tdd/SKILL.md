---
name: tdd
description: Write code test-first. Use when the user asks for TDD, red-green-refactor, a failing test first, or wants a feature or bug fix driven by tests.
---

# Test-Driven Development

Use this when the user wants the tests to drive the implementation. One slice at a time: red, green, refactor.

For examples of tests worth keeping and where mocks belong, read the [test quality reference](./references/test-quality.md).

## Before the first test

1. **Read how this codebase already tests.** Find the tests covering the area you are changing. Note the runner, the file layout, the naming style, the fixtures and helpers, and the level they test at: unit, module, HTTP, database-backed, end to end.
2. **Reuse the established level.** If the neighbors test through the HTTP handler, test through the HTTP handler. Matching the existing boundary is the default and does not need approval.
3. **Ask only about consequential choices.** A new public interface, a new module boundary, a schema change, or a level that does not exist yet and would need new infrastructure. If the codebase does not answer the question and getting it wrong is expensive, ask once and keep going.
4. **State the behavior under test in one sentence**, in the project's own vocabulary: "a user with an expired token gets 401 rather than 500".

## The loop

Run one slice at a time. A slice is one behavior: one test, then the smallest implementation that satisfies it.

### Red

Write one failing test that describes observable behavior through the interface a caller uses.

- Name it for what the caller can do, not how the code does it: `rejects checkout when the cart is empty`.
- Derive expected values independently: a literal from the specification, a worked example, a known-good output. An expectation computed the same way the implementation computes it repeats any mistake in that rule, so the test cannot catch it.
- Assert the specific symptom or result, not "it did not throw".
- Cover the boundary that matters for this slice: empty, zero, one, maximum, expired, unauthorized, concurrent.

**Run it and watch it fail for the reason you expect.** A test that fails on an import error or a typo has not told you anything yet.

### Green

Write the smallest implementation that makes the test pass. Do not add handling for cases no test asks for yet; those are the next slices.

**Run the test and watch it pass**, then run the surrounding tests to confirm nothing else broke.

### Refactor

With the tests green, clean up what you just wrote: naming, duplication between the new code and its neighbors, a clearer shape for the code you now understand better. Run the tests again.

This step is part of the loop, not something deferred to review. Keep it proportional: refactor what this slice touched. Wider restructuring is a separate task and a separate conversation.

Then start the next slice. Let what you learned reshape the next test rather than writing all the tests up front against imagined behavior.

## What to test

- **Public behavior.** Whatever a caller can observe through the interface: return values, raised errors, emitted events, persisted state read back through the same interface.
- **Boundaries.** Mock at the edges of your system: third-party APIs, payment and email providers, clock and randomness, sometimes the filesystem. Prefer a real test database over mocking your own data layer when the project already supports one.
- **Internal seams, with judgment.** A pure function with tricky logic, a parser, a state machine, or a scheduler is worth testing directly even though it is internal, especially when reaching it through the outer interface needs elaborate setup. Do it deliberately and know the cost: those tests are coupled to a structure that may change.

Tests that assert on call counts, call order, or private methods are usually testing the implementation rather than the behavior. They break on refactors that changed nothing a caller can see. Use them when the interaction *is* the behavior, such as "the payment provider is charged exactly once on retry", and not by default.

## Outcomes

- **Done** — every slice has a test that failed first and passes now, the surrounding suite passes, and temporary scaffolding is gone. Say which behaviors are covered and which are not.
- **Blocked on a decision** — an interface or boundary question you cannot answer from the codebase. State the options and your recommendation, and pause on that slice only.
- **Blocked on tooling** — no runner, no way to run the relevant tests, or the level you need does not exist and building it is a bigger task than the change. Say so instead of writing tests you cannot run.

---

Adapted from Matt Pocock's `tdd` skill. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
