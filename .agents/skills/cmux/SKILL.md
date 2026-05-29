---
name: cmux
description: Control cmux workspaces, panes, surfaces, status/sidebar, browser panels, and notifications.
---

# cmux

Use the `cmux` CLI for all cmux operations. Commands communicate via Unix socket.

## Detection

```bash
# Check if running inside cmux
[[ -n "$CMUX_WORKSPACE_ID" ]] && echo "in cmux"

# Environment vars auto-set in cmux terminals
$CMUX_WORKSPACE_ID   # Current workspace
$CMUX_SURFACE_ID     # Current surface
$CMUX_TAB_ID         # Current tab
```

## Workspace & Window Management

```bash
# List workspaces and windows
cmux list-workspaces
cmux list-windows
cmux current-workspace

# Create workspace
cmux new-workspace --cwd /path/to/dir

# Open a directory (launches cmux if needed)
cmux /path/to/project

# Rename
cmux rename-workspace --workspace workspace:1 "my-project"

# Switch
cmux select-workspace --workspace workspace:2
```

## Panes & Surfaces

```bash
# Tree view — shows full hierarchy with IDs
cmux tree
cmux tree --all  # all windows

# Create splits
cmux new-split right                          # split current pane
cmux new-split down --surface surface:1       # split specific surface
cmux new-split left --workspace workspace:1

# List surfaces and panes
cmux list-panes --workspace workspace:1
cmux list-pane-surfaces --pane pane:1

# Focus
cmux focus-pane --pane pane:2

# Close a surface
cmux close-surface --surface surface:3

# Resize
cmux resize-pane --pane pane:2 -R --amount 20  # grow right 20 cols
cmux resize-pane --pane pane:2 -D --amount 10  # grow down 10 rows

# Swap panes
cmux swap-pane --pane pane:1 --target-pane pane:2

# Move surface between panes
cmux move-surface --surface surface:1 --pane pane:2
```

**Important:** Surface IDs change when panels are closed and reopened. Always use `cmux tree` to discover current IDs before operating on surfaces.

## Sending Input

```bash
# Send text to a surface
cmux send --surface surface:3 "echo hello"

# Send a keypress
cmux send-key --surface surface:3 enter
cmux send-key --surface surface:3 ctrl-c
cmux send-key --surface surface:3 ctrl-d

# Common pattern: send command + enter
cmux send --surface surface:3 "make test"
sleep 0.1
cmux send-key --surface surface:3 enter
```

## Reading Screen Output

```bash
# Read current screen content
cmux read-screen --surface surface:3

# Include scrollback buffer
cmux read-screen --surface surface:3 --scrollback

# Last N lines
cmux read-screen --surface surface:3 --lines 50
```

## Sidebar Metadata

Status pills, progress bars, and log entries in the cmux sidebar.

```bash
# Status pills (key-value with icon and color)
cmux set-status pi "working" --icon terminal.fill --color "#ff9500"
cmux set-status tasks "3/5" --icon checklist --color "#007aff"
cmux clear-status pi
cmux list-status

# Progress bar (0.0 to 1.0)
cmux set-progress 0.5 --label "Building..."
cmux clear-progress

# Log entries
cmux log --level info --source pi -- "Started build"
cmux log --level success --source pi -- "Build complete"
cmux log --level error --source pi -- "Build failed"
cmux log --level warning --source pi -- "Deprecated API"
cmux log --level progress --source pi -- "Compiling..."
cmux clear-log
cmux list-log --limit 20

# Read full sidebar state
cmux sidebar-state
```

### Icon Names

Use SF Symbols names: `terminal.fill`, `checkmark.circle.fill`, `xmark.circle.fill`, `exclamationmark.triangle.fill`, `pencil`, `cpu`, `checklist`, `arrow.triangle.branch`, `square.grid.2x2`, `person.fill`.

## Notifications

```bash
# Desktop notification
cmux notify --title "Build Complete" --body "All tests passed" --subtitle "project-name"
```

## Browser Panels

```bash
# Open browser split
cmux browser open https://example.com

# Navigate
cmux browser goto https://example.com/page

# Read page content
cmux browser snapshot
cmux browser snapshot --compact

# Interact
cmux browser click "button.submit"
cmux browser type "input.search" "query text"
cmux browser eval "document.title"

# Screenshot
cmux browser screenshot --out /tmp/shot.png
```

## Identify Current Context

```bash
# What surface/workspace am I in?
cmux identify
cmux identify --no-caller  # without auto-detection
```

## Common Patterns

### Run a script in a split pane

```bash
# Create right split, send command, press enter
result=$(cmux new-split right)
surface_id=$(echo "$result" | grep -o 'surface:[^ ]*')
sleep 0.3
cmux send --surface "$surface_id" "cd /project && ./run.sh"
sleep 0.1
cmux send-key --surface "$surface_id" enter
```

### Restart a process in an existing surface

```bash
cmux send-key --surface surface:3 ctrl-c
sleep 0.5
cmux send --surface surface:3 "./start.sh"
sleep 0.1
cmux send-key --surface surface:3 enter
```

### Pass environment variables to a split

```bash
cmux send --surface surface:3 "MY_VAR=value ./script.sh"
sleep 0.1
cmux send-key --surface surface:3 enter
```

## Rules

1. **Always use `cmux tree`** to discover current surface/pane IDs — they change on close/reopen
2. **Use refs** like `surface:3`, `pane:1`, `workspace:1` — not raw UUIDs
3. **Add `sleep` delays** between send and send-key (0.1-0.3s) for reliable delivery
4. **Use `read-screen`** to verify command output instead of assuming success
5. **Handle surface:invalid** errors gracefully — the surface may have been closed
