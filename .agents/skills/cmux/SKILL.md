---
name: cmux
description: Control cmux workspaces, panes, surfaces, status/sidebar, browser panels, and notifications.
---

# cmux

Use the `cmux` CLI for all cmux operations. Commands communicate through the cmux Unix socket.

For command examples, read `references/command-reference.md`.

## Preflight

Check that the CLI is available before trying to control cmux:

```bash
command -v cmux
```

If `cmux` is unavailable, say so and stop. Do not fake cmux state.

To detect whether the current terminal is inside cmux, check `CMUX_WORKSPACE_ID`.

## Workflow

1. Use `cmux tree` to discover the current workspace, pane, and surface IDs.
2. Use refs like `workspace:1`, `pane:2`, and `surface:3`; do not use raw UUIDs.
3. Run the requested operation.
4. Use `cmux read-screen` or another read/list command to verify the result when it matters.
5. If a surface operation fails with `surface:invalid`, refresh IDs with `cmux tree` and retry only if the user request still makes sense.

## Common operations

- Workspaces and windows: list, create, rename, select.
- Panes and surfaces: split, focus, close, resize, swap, move.
- Input: send text or keypresses to a surface.
- Output: read the screen or scrollback.
- Sidebar: set status pills, progress, and log entries.
- Notifications: send desktop notifications.
- Browser panels: open, navigate, snapshot, click, type, evaluate JavaScript, or screenshot.

## Rules

1. **Always use `cmux tree`** to discover current surface and pane IDs; they change when panels close or reopen.
2. **Use refs** like `surface:3`, `pane:1`, and `workspace:1`; not raw UUIDs.
3. **Add short sleeps** between `cmux send` and `cmux send-key` calls, usually 0.1–0.3 seconds.
4. **Verify output** with `read-screen` or list commands instead of assuming success.
5. **Handle `surface:invalid` gracefully**; the surface may have been closed.
