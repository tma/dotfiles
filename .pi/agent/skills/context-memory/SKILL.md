---
name: context-memory
description: Maintains project memory across sessions using markdown files. Tracks decisions, work state, and open questions. Use at session start to resume context, and before ending to preserve it.
---

# Context Memory

Persistent project memory using plain markdown files — no external tools, no databases.

## Session Start

At the beginning of every session, check for existing context:

```bash
cat HANDOFF.md 2>/dev/null
cat .decisions.md 2>/dev/null
```

If `HANDOFF.md` exists, read it fully before doing anything else. It contains the state from the previous session.

## During Work

### Recording Decisions

When making a non-trivial decision (architecture, library choice, approach, tradeoff), append it to `.decisions.md`:

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

Example:
```
feat: add JWT auth middleware

Using httpOnly cookies instead of localStorage for token storage.
Stateless validation lets us scale horizontally without session store.

Decision: JWT over server sessions — avoids shared state across instances
```

## Before Ending a Session

Before the session ends (or when asked to hand off), write `HANDOFF.md` in the project root:

```markdown
# Handoff

## Status
Brief summary of where things stand.

## Done
- [x] Completed item with enough detail to verify
- [x] Another completed item

## Remaining
- [ ] Specific next task
- [ ] Another pending task (with any notes on approach)

## Blocked
- Anything waiting on external input or unresolved questions

## Key Decisions This Session
- **<decision>**: <rationale> (also logged in .decisions.md)

## Open Questions
- Questions that need human input or further investigation
- Uncertainties about approach

## Files Changed
- `path/to/file.ts` — what changed and why
- `path/to/other.ts` — what changed and why

## Context for Next Session
Any critical context that would be lost — error messages seen,
edge cases discovered, patterns to follow, things already tried
that didn't work.
```

`HANDOFF.md` is **overwritten** each session (it's current state, not a log).
`.decisions.md` is **appended** each session (it's a permanent record).

## Rules

1. **Always check for HANDOFF.md at session start** — it's your memory from last time
2. **Always write HANDOFF.md before ending** — even for small sessions
3. **Log decisions as you make them** — don't batch at the end when you've forgotten rationale
4. **Be specific** — "implemented auth" is useless; "added JWT middleware in src/auth/middleware.ts with RS256 validation" is useful
5. **Record what didn't work** — failed approaches are valuable context that prevents re-trying them
6. **Keep HANDOFF.md under 100 lines** — if it's longer, you're including too much detail

## Gitignore

Add `HANDOFF.md` to `.gitignore` if you don't want it committed (it's working state).
Keep `.decisions.md` tracked — it's documentation.

```bash
echo "HANDOFF.md" >> .gitignore
```
