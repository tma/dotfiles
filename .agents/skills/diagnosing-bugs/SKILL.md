---
name: diagnosing-bugs
description: Diagnose bugs, crashes, wrong output, flaky behavior, and performance regressions. Use when the user reports something broken, failing, slow, or intermittent, or asks you to debug or find a root cause.
---

# Diagnosing Bugs

Use this for diagnosis, not for routine fixes with an obvious cause. The discipline is: get a signal you trust, then narrow it, then test ideas against it one at a time.

Two modes. Pick one before starting:

- **Reproducible** — you can run the failure locally or in a safe environment. Follow the main path below.
- **Evidence-led** — production-only, intermittent, already-passed, or no safe way to reproduce. Read the [evidence-led diagnosis reference](./references/evidence-led.md) instead of steps 2-4, and keep steps 1, 5, and 6.

Do not promise a diagnosis. Some bugs end with a ranked set of suspects and the next measurement to take, and that is a legitimate result.

## 1. Capture the report before touching code

Write down, from the user or the ticket:

- The exact symptom: error text, wrong value, timing, screenshot, log line.
- Where it happened: environment, version or commit, configuration, user or tenant, time window.
- How often, and whether anything changed near the first occurrence.
- What "fixed" would look like.

Ask for what is missing rather than guessing. **Done when:** you can state the symptom in one sentence using the user's own terms, and you know which mode applies.

### Redaction

You will be quoting commands, output, and captured artifacts. Replace secrets, tokens, cookies, customer data, internal hostnames, and personal data with `<REDACTED>` before showing anything. Keep credentials in environment variables so loops can run without printing them. Quote only the lines carrying the signal.

If the redacted evidence is not enough to diagnose the bug, say so and ask the user how to proceed.

## 2. Build a repeatable check

Get one command you can run that fails while the bug is present and passes when it is fixed. Prefer, in order:

1. A failing test at whatever level reaches the bug.
2. A request script against a running local server.
3. A CLI invocation with a fixture input, compared against known-good output.
4. A browser script that drives the interface and asserts on what the user saw.
5. Replaying a captured payload, request, or event log through the code path in isolation.
6. A throwaway script that calls the failing code path directly with mocked dependencies.
7. A repeated run over many inputs when the failure is input-dependent.
8. An automated check across commits or versions when the failure appeared between two known-good states.

Then tighten it: make it faster, make it assert the user's exact symptom rather than "did not crash", and make it deterministic (pin time, seed randomness, isolate the filesystem, stub the network).

For intermittent failures, raise the failure rate where you can: loop the trigger, run in parallel, narrow timing windows. Record the rate and the sample size ("7 failures in 500 runs") so later steps can tell a real change from noise. A low rate is still workable: compare failing and passing runs statistically instead of forcing the rate up with stress the system may not tolerate.

**Done when:** you can name one command you have already run, show its output, and say that it failed on this bug. **If you cannot get there**, say so explicitly, list what you tried, and switch to evidence-led mode rather than theorizing without a signal.

## 3. Minimize

With the check failing, cut it down: remove inputs, callers, configuration, data, and steps one at a time, re-running after each cut. Keep only what the failure needs.

A minimal case shrinks the list of suspects and usually becomes the regression test.

**Done when:** removing any remaining element makes the check pass.

## 4. Rank hypotheses, then test one variable at a time

Write 3-5 candidate causes before testing any of them, ranked, each with a prediction that could prove it wrong:

> If the stale cache entry is the cause, clearing it between requests makes the failure disappear.

A candidate with no prediction is a hunch. Sharpen it or drop it.

Show the ranked list to the user before you start testing. They often know that one of them shipped last week, or that another was already ruled out. Do not block on the answer; continue with your own ranking if they are away.

Then instrument:

- Use a debugger or REPL when the environment supports it; one breakpoint beats ten log lines.
- Otherwise add targeted logging at the boundaries that distinguish two hypotheses. Do not log everything and grep.
- Tag every temporary log or probe with a unique marker such as `[DEBUG-a4f2]` so cleanup is one search.
- Change one variable per run. Two changes at once means you learned nothing.
- For performance regressions, measure before you theorize: a timing harness, a profile, or a query plan, then narrow.

**Done when:** one hypothesis survives its own falsifying test and the others are ruled out, or you can state which measurement would separate the remaining candidates.

## 5. Fix with a regression test first

Write the test before the fix when there is a level where the test exercises the real failure. If the only available place is too shallow to reproduce the actual pattern, say so: a test that passes for the wrong reason is worse than no test, and the missing seam is itself a finding worth reporting.

When a workable test level exists:

1. Turn the minimized case into a test and watch it fail.
2. Apply the fix.
3. Watch it pass.
4. Re-run the original, un-minimized check from step 2 and confirm the symptom the user reported in step 1 is gone. In evidence-led mode, report what remains unverified if there is no safe runnable check.

## 6. Clean up and report

Before declaring done:

- [ ] Every tagged probe removed from code you control; search the tag to confirm.
- [ ] Throwaway scripts deleted or moved somewhere clearly marked.
- [ ] Temporary instrumentation on live systems handled per the agreement described under Safety, not left implicit.

When a fix was applied, also confirm:

- [ ] The regression test passes, or its absence is documented with the reason.
- [ ] The original reported scenario no longer reproduces, verified by running it where safe and possible. Otherwise label the patch unverified against the original scenario and name the observation still needed; do not claim a confirmed fix.

When no fix was applied, skip those two. Stopping at ranked suspects plus the next measurement is a complete result; do not imply a fix that does not exist.

If you are writing a commit or PR message for this work, state the cause that survived testing in it so the next person reading the history learns it. That is guidance for a message you are already writing, not permission to commit, push, or publish. Those still need the user to ask.

Report with the confidence you actually have:

- **Confirmed** — the check went red, the fix made it green, the original scenario is clean.
- **Likely** — evidence points one way but you could not close the loop. Say what would confirm it.
- **Unresolved** — ranked suspects plus the next measurement. Say what blocked you: missing access, missing telemetry, no safe reproduction, redacted evidence that lost the signal.

## Safety

- Never run writes, replays, restarts, stress, or load against production or shared environments without explicit permission for that specific action.
- Never replay captured traffic that carries real customer data into another environment without permission.
- Temporary production instrumentation is a request, not a step you take on your own. When the user agrees to it, agree at the same time on how long it stays, who removes it, and what happens if the session ends before the failure is observed. Put that agreement in your report.
- Do not promise unattended cleanup of a live system you may not be able to touch later. Hand removal back to its owner explicitly.
- Remove every temporary probe you added to the repository before the session ends.

---

Adapted from Matt Pocock's `diagnosing-bugs` skill. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
