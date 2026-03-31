---
name: context-memory
description: Maintains project memory across sessions using JSON handoff files and a markdown decision log. Tracks decisions, work state, and open questions. Use at session start to resume context, and before ending to preserve it.
---

# Context Memory

Persistent project memory using JSON handoff files and a markdown decision log.

## Session Directory

All session state lives in `~/.pi/agent/sessions/<encoded-cwd>/`. Derive the path:

```bash
SESSION_DIR="$HOME/.pi/agent/sessions/--$(pwd | sed 's|^/||; s|/|-|g')--"
```

The encoding replaces `/` with `-` and wraps in `--`. Verify the directory exists before reading — if it doesn't, there are no prior sessions for this project.

## Session Start

At the beginning of every session, check for existing context:

```bash
SESSION_DIR="$HOME/.pi/agent/sessions/--$(pwd | sed 's|^/||; s|/|-|g')--"
cat "$SESSION_DIR/handoff.json" 2>/dev/null
cat .decisions.md 2>/dev/null
```

If `handoff.json` exists, read it fully before doing anything else. It contains the state from the previous session.

## During Work

### Recording Decisions

When making a non-trivial decision (architecture, library choice, approach, tradeoff), append it to `.decisions.md` in the project root:

```markdown
## YYYY-MM-DD: <short title>

**Context**: What prompted this decision
**Decision**: What we chose
**Alternatives considered**: What else we looked at
**Rationale**: Why this choice over others
```

Decisions are append-only. Never edit or remove previous entries. The file is a log.

### Commit Messages

Use structured commit messages that capture *why*, not just *what*:

```
<type>: <what changed>

<why this approach was taken>

Decision: <key choice made, if any>
```

Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`

## Before Ending a Session

Before the session ends (or when asked to hand off), write `handoff.json` in the session directory:

```bash
SESSION_DIR="$HOME/.pi/agent/sessions/--$(pwd | sed 's|^/||; s|/|-|g')--"
```

```json
{
  "status": "Brief summary of where things stand",
  "done": [
    "Completed item with enough detail to verify",
    "Another completed item"
  ],
  "remaining": [
    "Specific next task",
    "Another pending task (with any notes on approach)"
  ],
  "blocked": [
    "Anything waiting on external input or unresolved questions"
  ],
  "decisions": [
    { "decision": "short title", "rationale": "why" }
  ],
  "openQuestions": [
    "Questions that need human input or further investigation"
  ],
  "filesChanged": [
    { "path": "path/to/file.ts", "what": "what changed and why" }
  ],
  "context": "Critical context that would be lost — error messages seen, edge cases discovered, patterns to follow, things already tried that didn't work."
}
```

`handoff.json` is **overwritten** each session (it's current state, not a log).
`.decisions.md` is **appended** each session (it's a permanent record).

## Rules

1. **Always check for handoff.json at session start** — it's your memory from last time
2. **Always write handoff.json before ending** — even for small sessions
3. **Log decisions as you make them** — don't batch at the end when you've forgotten rationale
4. **Be specific** — "implemented auth" is useless; "added JWT middleware in src/auth/middleware.ts with RS256 validation" is useful
5. **Record what didn't work** — failed approaches are valuable context that prevents re-trying them
6. **Keep it concise** — handoff.json should capture essential state, not exhaustive detail
