---
name: kusto
description: Query Azure Data Explorer/Kusto logs, metrics, and events.
---

# Kusto / Azure Data Explorer

Use this skill for generic Kusto investigations. Do not assume any organization,
cluster, database, table, service, environment, subscription, tenant, or naming
convention unless the user provides it or it is present in the repository being
inspected.

## Inputs to establish

Ask for or infer only from local project context:

- Cluster URI
- Database name
- Table names or functions to query
- Time column and time window
- Relevant service, host, resource, environment, request ID, operation ID, or correlation ID
- The symptom: errors, latency, missing events, volume anomaly, ingestion lag, or alert

## Authentication

Use credentials from the local environment or configured tooling. Common environment
variables are:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_AUTHORITY_HOST`

Interactive Azure login, Azure CLI credentials, or managed identity may also be
available depending on the environment. Useful generic checks:

```bash
command -v az
az account show
az login
```

Never print credential values, access tokens, tenant IDs, or subscription IDs. If
authentication is missing, report the missing configuration and stop.

## Query guidelines

1. Always time-bound queries first.
2. Start with `count`, `summarize`, and small projections before returning raw rows.
3. Use indexed or commonly filtered columns before scanning dynamic payloads.
4. Prefer `where timestamp between (...)` or equivalent bounded filters.
5. Use `take`/`limit` for samples and `project` only the fields needed.
6. Keep query text, cluster, database, table, and time range in the report.
7. Expand scope only after a narrow query shows it is useful.

## KQL patterns

```kusto
TableName
| where Timestamp between (datetime(2026-01-01T00:00:00Z) .. datetime(2026-01-01T01:00:00Z))
| summarize Count=count() by bin(Timestamp, 5m), Result
| order by Timestamp asc
```

```kusto
TableName
| where Timestamp > ago(1h)
| where OperationId == "<correlation-id>"
| project Timestamp, Level, Message, OperationId
| take 100
```

## Output format

Return:

- **Summary:** current state and whether the data shows an anomaly
- **Evidence:** cluster/database/table, query, time range, filters, counts, and redacted samples
- **Likely cause:** only if supported by evidence
- **Next checks:** focused follow-up queries or fields to inspect

## Safety

- Do not invent clusters, databases, tables, subscriptions, tenants, or services.
- Do not expose secrets, tokens, session cookies, or sensitive payloads from query results.
- Redact personal data and sensitive values in samples.
- Avoid broad unbounded scans.
