---
name: datadog
description: Query Datadog metrics, logs, traces, monitors, events, dashboards, and SLOs.
---

# Datadog

Use this skill for generic Datadog investigations. Do not assume any organization,
service, dashboard, monitor, tag, environment, or naming convention unless the user
provides it or it is present in the repository being inspected.

## Inputs to establish

Ask for or infer only from local project context:

- Datadog site, for example `datadoghq.com`, `datadoghq.eu`, or another configured site
- Time window and timezone
- Service, resource, host, cluster, environment, or tag filters
- Signal type: metrics, logs, traces/APM, monitors, events, SLOs, dashboards
- The symptom: latency, errors, saturation, throughput, deployment change, alert, or anomaly

## Authentication

Use credentials from the local environment or configured tooling. Common environment
variables are:

- `DD_API_KEY`
- `DD_APP_KEY`
- `DD_SITE`

Never print credential values. If authentication is missing, report the missing
configuration and stop.

## Optional CLI: pup

If the `pup` CLI is installed and authenticated, it is a useful generic Datadog
interface. Do not assume it is available; check first:

```bash
command -v pup
pup version
pup auth test
```

Common examples:

```bash
# Metrics
pup metrics query --query "avg:system.cpu.user{*}" --from "1h"
pup metrics search --query "avg:system.cpu.user{*}" --from "1h"

# Monitors and dashboards
pup monitors list
pup monitors search --query "service:example"
pup dashboards list

# Events, SLOs, and APM
pup events search --query "deploy" --from "1h" --to "now"
pup slos list
pup apm services stats --env production --from "1h"
pup traces search --query "service:example" --from "1h"
```

Guidelines when using `pup`:

- Prefer JSON output when available and parse it before summarizing.
- Time-bound every query.
- Use single quotes for queries containing shell-sensitive characters like `!`.
- Keep raw output small: aggregate first, then sample.
- If `pup` is unavailable or unauthenticated, fall back to another configured
  Datadog API/client or ask the user how they want to query Datadog.

## Investigation flow

1. Bound every query by time first.
2. Start broad, then narrow by tags and resources.
3. Compare against a baseline when possible.
4. Correlate across signals:
   - metrics for trend and saturation
   - logs for examples and error messages
   - traces for request paths and dependencies
   - events for deploys or infrastructure changes
   - monitors/SLOs for alert context and impact
5. Prefer aggregate views before sampling individual records.
6. Keep notes on filters used so results are reproducible.

## Output format

Return:

- **Summary:** current state and whether the signal looks abnormal
- **Evidence:** metric/log/trace/event names, filters, time windows, and counts
- **Likely cause:** only if supported by evidence
- **Next checks:** the smallest useful follow-up queries

## Safety

- Do not invent service names, tags, dashboards, monitors, or incident context.
- Do not expose secrets, tokens, session cookies, or raw credentials from logs.
- Redact personal data and sensitive request payloads when summarizing examples.
- Avoid wide unbounded log or trace queries.
