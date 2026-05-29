---
name: context-memory
description: Use Pi session history for cross-session context; do not create memory files.
---

# Context Memory

Use Pi's native session history as the default source of continuity.

Do **not** create project-root memory files, sidecar handoff files, or decision logs just to preserve context.

## Default Policy

- Never write `HANDOFF.md`, `.decisions.md`, `handoff.json`, or similar bookkeeping files by default.
- Never add memory bookkeeping files to `.gitignore` by default.
- Only create a handoff/decision file if the user explicitly asks for a file-based artifact.
- Prefer keeping continuity in Pi sessions, session names, tree labels, plans, and todo state.

## Session Start

When resuming work:

1. Use the current conversation context if it already contains enough information.
2. If the user wants prior context and it is not present in the current thread, prefer Pi's built-in session mechanisms over writing or reading ad hoc files:
   - `/resume` to find an older session
   - `/tree` to navigate prior branches
   - session naming / labels when available
3. If the user asks for a summary of prior work, provide it inline in chat unless they explicitly request a file.

## During Work

- Keep important decisions visible in the conversation itself.
- Use todo tracking or plan files when they are part of the work, not as generic memory storage.
- If durable documentation is needed for the project itself (ADR, design doc, README update, migration notes), create that documentation only when it is genuinely part of the task.
- Do not invent persistent memory artifacts just for agent convenience.

## Handoffs

- Prefer inline handoff summaries in the conversation.
- If the setup includes a `/handoff` command, prefer that over writing custom handoff files.
- Only write a handoff file when the user explicitly requests a file-based handoff.

## Rules

1. **Default to zero memory files**.
2. **Use Pi sessions as memory**.
3. **Prefer inline summaries over file writes**.
4. **Create documentation only when it serves the project, not bookkeeping**.
5. **If unsure, do not persist anything extra**.
