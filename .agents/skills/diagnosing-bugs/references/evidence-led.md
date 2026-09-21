# Evidence-led diagnosis

Read this when the failure cannot be reproduced safely: it only happens in production, it happened once, it needs data or scale you do not have, or reproducing it would mean touching a live system.

The goal shifts from "make it fail on demand" to "constrain the cause with the evidence that already exists". You may finish without a diagnosis. Say so plainly rather than presenting a guess as a conclusion.

## What to gather

Work from artifacts that already exist, read-only:

- Error text, stack traces, and the request or correlation identifier for a specific failing occurrence.
- Logs around that occurrence, bounded by a time window. Start narrow.
- Metrics for the same window: error rate, latency percentiles, saturation, throughput, and the same series a day and a week earlier as a baseline.
- Traces for the failing request path and its dependencies.
- Deployments, configuration changes, feature flag flips, migrations, and infrastructure events near the first occurrence.
- The code as it was at the failing version, not only `main`.

The `datadog` and `kusto` skills own the query mechanics and their own safety rules. Use them for the actual queries.

Redact secrets, tokens, customer data, internal hostnames, and personal data in everything you quote.

## How to reason

- Anchor on one concrete failing occurrence and follow it end to end before generalizing.
- Separate what the evidence shows from what you infer from it. Label inferences.
- Look for the boundary: which requests fail and which succeed, since when, which version, which region, which tenant shape, which input shape. The line between failing and working is the strongest constraint you have.
- Correlate timing against changes, but say "correlates with" rather than "caused by" until something else supports it.
- When two candidates both fit, name the observation that would separate them: a log line that does not exist yet, a metric not being collected, a field not being recorded. That gap is a finding.

## Trying to get a loop back

Before settling, check whether a safe reproduction is now within reach:

- A captured payload, request, or event replayed locally against the failing code path.
- A local run pinned to the failing version and configuration.
- A test fixture built from the shape of the failing input, with real data replaced.

If one works, go back to the main path in [SKILL.md](../SKILL.md).

## Asking for what you need

When the evidence runs out, ask for one of these, explicitly and one at a time:

- Read access to the environment that reproduces it.
- A redacted captured artifact: log export, request capture, trace, core dump, or a recording with timestamps.
- Permission to add temporary instrumentation to production, naming exactly what you would add, where, for how long, who removes it, and what happens if the session ends before the failure occurs.

## Hard limits

None of the following happen without explicit permission for that specific action:

- Writes, deletes, restarts, scaling, configuration changes, or feature flag flips in production or any shared environment.
- Replaying captured traffic that carries real customer data.
- Load, stress, or fault injection against a live system.
- Exporting production data to a local machine.

## Reporting

- **Symptom** — the user's reported failure, in their terms.
- **Evidence** — queries, filters, time windows, counts, and redacted samples, enough for someone else to re-run.
- **Constraints** — what the evidence rules out and what it narrows the failure to.
- **Ranked candidates** — each with the observation that supports it and the observation that would refute it. Label confidence.
- **Next measurement** — the smallest thing that would separate the top candidates.
- **Blockers** — missing access, missing telemetry, permissions not granted, signal lost to redaction.
