# PR evidence and merge risk

Optional additions to a PR body. Use them when they help a reviewer decide, not as
a fixed template. The repository's own PR template always wins: if it prescribes
headings and order, fit this material into it, and keep the why-first prose first.

## Evidence

Show that the change works, with output you actually produced.

- **Before and after.** The failing behavior, then the same check passing. A test
  that fails on `main` and passes on the branch is the strongest form.
- **Name the check.** Give the command and the relevant lines of its output, not
  "tests pass". A reviewer should be able to run the same thing.
- **Trim, do not invent.** Paste real output and cut the noise. Never write output
  a command did not produce, never fabricate a run you did not do, and never
  reconstruct results from memory. If you did not run it, say what you did instead.
- **Say what is untested.** Paths you could not exercise (a production integration,
  a device you do not have, a migration against real data) belong in the body as
  gaps, not as silence.
- **Screenshots** only for visible changes, and only when you actually captured
  them.

A short, honest evidence section:

```markdown
## Verification

`npm test -- retry` — 14 passing, including the new `retries stop after the
deadline` case, which fails on `main` with `Error: exceeded 30s`.

Not covered: behavior against the live provider. The retry path is exercised
only against the local fake.
```

## Merge risk

Two things a reviewer cannot get from the diff:

- **Rollback difficulty.** Can this be reverted cleanly, or does something make it
  one-way? Data migrations, deleted columns, published artifacts, external state
  changes, and anything customers see immediately are hard to walk back. Say which
  it is and what a rollback would involve.
- **Blast radius.** What breaks if it is wrong, and for whom. Name the callers,
  the surfaces, or the population: every request through the auth middleware, only
  the admin export page, consumers pinned to version 2.

Keep it to a few lines, and only when there is real risk to describe:

```markdown
## Merge risk

Rollback: revert is clean; no schema or stored-data changes.
Blast radius: every request through the retry wrapper. A wrong deadline shows
up as slower failures, not as data loss.
```

Skip the section for changes where the honest answer is "revert it, nothing else
is affected". An empty risk section on every PR trains reviewers to skip it.

## Order

Why the change exists comes first, always. Evidence and risk support the argument;
they do not replace it. See the
[why-first reference](../../writing-voice/references/why-first.md).

---

Evidence and risk guidance draws on Matt Pocock's in-progress `pr` skill; its third-party visual examples are not reproduced. See [third-party notices](../../THIRD_PARTY_NOTICES.md).
