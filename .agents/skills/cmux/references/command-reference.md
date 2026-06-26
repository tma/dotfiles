# cmux command reference

Use `cmux tree` before commands that need pane, surface, workspace, or tab IDs. Surface IDs can change when panels are closed and reopened.

## Detection

```bash
# Check whether running inside cmux
[[ -n "$CMUX_WORKSPACE_ID" ]] && echo "in cmux"

# Environment variables auto-set in cmux terminals
$CMUX_WORKSPACE_ID   # Current workspace
$CMUX_SURFACE_ID     # Current surface
$CMUX_TAB_ID         # Current tab
```

## Workspace and window management

```bash
# List workspaces and windows
cmux list-workspaces
cmux list-windows
cmux current-workspace

# Create workspace
cmux new-workspace --cwd /path/to/directory

# Open a directory, launching cmux if needed
cmux /path/to/project

# Rename
cmux rename-workspace --workspace workspace:1 "my-project"

# Switch
cmux select-workspace --workspace workspace:2
```

## Panes and surfaces

```bash
# Tree view shows the full hierarchy with IDs
cmux tree
cmux tree --all

# Create splits
cmux new-split right
cmux new-split down --surface surface:1
cmux new-split left --workspace workspace:1

# List surfaces and panes
cmux list-panes --workspace workspace:1
cmux list-pane-surfaces --pane pane:1

# Focus
cmux focus-pane --pane pane:2

# Close a surface
cmux close-surface --surface surface:3

# Resize
cmux resize-pane --pane pane:2 -R --amount 20
cmux resize-pane --pane pane:2 -D --amount 10

# Swap panes
cmux swap-pane --pane pane:1 --target-pane pane:2

# Move surface between panes
cmux move-surface --surface surface:1 --pane pane:2
```

## Sending input

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

## Reading screen output

```bash
# Read current screen content
cmux read-screen --surface surface:3

# Include scrollback buffer
cmux read-screen --surface surface:3 --scrollback

# Last N lines
cmux read-screen --surface surface:3 --lines 50
```

## Sidebar metadata

Status pills, progress bars, and log entries appear in the cmux sidebar.

```bash
# Status pills: key-value with icon and color
cmux set-status pi "working" --icon terminal.fill --color "#ff9500"
cmux set-status tasks "3/5" --icon checklist --color "#007aff"
cmux clear-status pi
cmux list-status

# Progress bar, 0.0 to 1.0
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

Use SF Symbols icon names: `terminal.fill`, `checkmark.circle.fill`, `xmark.circle.fill`, `exclamationmark.triangle.fill`, `pencil`, `cpu`, `checklist`, `arrow.triangle.branch`, `square.grid.2x2`, `person.fill`.

## Notifications

```bash
cmux notify --title "Build Complete" --body "All tests passed" --subtitle "project-name"
```

## Browser panels

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

## Identify current context

```bash
cmux identify
cmux identify --no-caller
```

## Common patterns

### Run a script in a split pane

```bash
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
