# Subagent policy tests

Run the resolver tests with Node.js built-in TypeScript stripping:

```sh
node --experimental-strip-types --test .pi/agent/tests/model-selection.test.ts
```

Run resolver and launcher smoke tests together:

```sh
node --experimental-strip-types --test .pi/agent/tests/*.test.ts
```

The launcher and runtime tests also need Node's `node:module.stripTypeScriptTypes` API. They execute the actual exported subagent extension and launcher helpers with fake session, storage, and sandbox boundaries. No model calls are made.

Coverage now includes:
- completion lifecycle delivery from real `registerTool.execute` paths (parallel early completion, retry after failed coordinator send, owner/session shutdown guards, and per-child de-duplication);
- `before_agent_start` reminder content and completion error formatting behavior;
- runAgent naming lifecycle (fallback title, optional refinement update, abort cleanup for timers/listeners);
- compact main-session status formatting (session name + agent type + lifecycle + model + thinking, optional recent action line) without job IDs;
- status-panel embedded Python rendering at narrow widths with sanitization checks.

Real-Pi integration tests skip with a setup message unless `PI_TEST_NODE_MODULES` is set. Point it at an existing external `node_modules` directory containing `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and their runtime dependencies:

```sh
PI_OFFLINE=1 PI_TEST_NODE_MODULES=/path/to/node_modules \
  node --experimental-strip-types --test .pi/agent/tests/*.test.ts
```

Integration tests report the supplied Pi version rather than pinning a patch release. A configured invalid path or incompatible API fails the run. They use memory credentials/catalogs and a temporary external agent directory, with no model calls or repository authentication/session files.

The runtime-only credential test reproduces a known unresolved limitation: parent authentication succeeds, but the independent child has no credential. Its passing assertion documents the blocker; it does not establish support for credential propagation.

## Inspecting children

Use `/agents` or `Ctrl+Shift+A` to inspect current-session children, including while the main model is running. Select a child with the arrow keys and Enter. Detail is read-only: arrow keys and Page Up/Down scroll, Home/End jump within the page, `]` opens the next detail page, and `[` returns to the first. Escape returns to the list, then closes it.

In detail, `s` asks for steering input, `f` asks for follow-up input, and `x` asks to stop the whole job. Stop requires confirmation. Direct commands use zero-based child indices:

```text
/agents steer <job-id> 0 Check the failing test first
/agents follow-up <job-id> 0 Summarize the remaining risks
/agents stop <job-id>
```

Queueing before a child starts is reported as not yet delivered. Acceptance by a running child means Pi accepted the input into its queue, not that the child has acted on it. Completed children cannot accept input.

For model-facing detail, call `subagent` with `action: "status"`, `view: "detail"`, `id`, and `index`. Responses are bounded to 16 KiB; pass the returned character `offset` for another page. Default status stays compact. The inspector excludes thinking content, escapes terminal controls, and keeps recent assistant and tool output tails. Tool arguments are limited to 1 KiB in live tracking; full arguments and output remain in the native session when saved. The existing 16 KiB retained-message limit is unchanged.

Native child sessions live under `~/.local/state/pi/subagent-sessions/<owner-key>/`, outside the repository. `/agents saved` lists the current parent's native session paths after completion or reload. Inspect those JSONL files as read-only data; do not open a live child in another writing agent. Saved files can contain full prompts, tool output, and native thinking entries. They aren't deleted automatically.

Pi creates a session file after its first assistant message. Until then, detail labels its allocated path as pending, not saved. An early interruption can leave no transcript. Persistence failures are reported; live jobs aren't restored, resumed, or replayed after reload.

Inspector tests cover event tracking, recent-output tails, interrupted tool durations, detail bounds, terminal controls, child ownership, control dispatch, persistence paths, and UI cleanup. They use fake SDK/TUI boundaries unless `PI_TEST_NODE_MODULES` is supplied. In a VM with a host-only `TMPDIR`, run checks with a valid temporary directory:

```sh
TMPDIR=/tmp node --experimental-strip-types --test .pi/agent/tests/*.test.ts
```
