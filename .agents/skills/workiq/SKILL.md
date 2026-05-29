---
name: workiq
description: Search and summarize Microsoft 365 mail, meetings, chats, files, and docs.
---

# WorkIQ / Microsoft 365 Content Search

Use this skill for generic Microsoft 365 content discovery and summarization through
a configured WorkIQ command-line tool or connector. Do not assume any organization,
tenant, site, mailbox, team, channel, drive, document library, or naming convention
unless the user provides it or it is present in the local project context.

## Inputs to establish

Ask for or infer only from local context:

- The question to answer or content to find
- Time range, if relevant
- Content types: documents, email, calendar events, chat messages, meeting notes, files, or pages
- Scope: tenant, site, mailbox, drive, team, channel, folder, author, attendee, or keyword filters
- Whether the user needs a summary, source list, comparison, timeline, or direct answer

## Authentication

Use credentials and permissions from the configured local WorkIQ tool or connector.
Do not ask the user for raw tokens or passwords. Never print credential values.
If authentication or authorization is missing, report the missing configuration and
stop.

## Optional CLI: npx

If the public WorkIQ CLI is available, it can be run through `npx` without assuming
a global install:

```bash
npx -y @microsoft/workiq --help
npx -y @microsoft/workiq ask -q "Find recent documents about the project plan"
```

Use CLI-specific options only when the user provides the relevant account, file,
or scope. Do not include tenant names, account emails, or document URLs unless the
user provided them for the task.

## Search workflow

1. Restate the search goal in one sentence.
2. Start with the narrowest useful query and time range.
3. Prefer metadata and snippets before summarizing whole documents.
4. Keep track of filters, result counts, and source types.
5. When summarizing, separate sourced facts from interpretation.
6. Cite source titles, dates, authors, or stable identifiers when available.
7. Ask a follow-up question if the scope is too broad or ambiguous.

## Output format

Return:

- **Answer:** short direct response when possible
- **Sources:** titles, dates, content types, and stable identifiers or links when available
- **Evidence:** key excerpts or summarized facts, with sensitive details redacted
- **Gaps:** what was not found or what access was unavailable
- **Next:** suggested follow-up search or narrower filter

## Safety

- Do not invent documents, people, teams, mailboxes, sites, or permissions.
- Do not expose secrets, tokens, private keys, session cookies, or sensitive payloads.
- Redact personal data unless it is necessary for the user's requested task and appropriate for the audience.
- Do not bypass access controls; only use content available to the configured user/tool.
- Do not quote large chunks of private documents. Summarize instead, unless the user explicitly asks for a short excerpt and access is appropriate.
