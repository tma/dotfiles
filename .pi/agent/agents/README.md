# Subagent model policies

Agent frontmatter can select a model at launch time instead of pinning a release:

```yaml
model: auto:balanced # auto:cheap, auto:balanced, or auto:strong
thinking: medium     # off, minimal, low, medium, high, xhigh, or max
provider: openrouter # optional exact provider constraint
family: claude-opus  # optional normalized token-sequence constraint
```

Explicit `provider/model[:thinking]` pins still work. A malformed or missing pin, unavailable authentication, or an empty constrained automatic selection fails the child. Automatic and pinned policies never fall back to the parent model. An older agent with no model policy inherits the parent model for compatibility, and the selection reason says so.

`model` can also be an ordered, comma-separated fallback list of pins and automatic policies:

```yaml
model: github-copilot/claude-opus-4.5, xai/grok-4, auto:strong
```

Each candidate is tried in order with the same `thinking`, `provider`, and `family` constraints, and the first one that exists in the catalog, matches the constraints, and authenticates wins. That's the same availability check a single value gets; subagents don't consult `enabledModels` or `scopedModels` (see below). The `selection:` line in status and the inspector names the winning candidate and why earlier ones were rejected. If no candidate works, the child fails with each candidate's rejection reason. A malformed candidate or an empty entry fails the launch instead of being skipped. The ten-second selection deadline covers the whole list. The same list syntax works for the `model` launch parameter.

The `subagent` tool accepts `model`, `thinking`, `provider`, and `family` on a single launch, as shared defaults for parallel tasks or chains, and on each task or chain step. Precedence is step/task override, shared launch default, then agent frontmatter. Thinking uses the same order, followed by a pin's `:thinking` suffix and then the parent level. Pi clamps the requested level to the selected model's supported levels and reports both the effective level and the reason.

Subagent policies intentionally use all available provider catalogs, independently of the main session's `enabledModels` / `scopedModels` cycling list. Restrict subagents with `provider`, `family`, or explicit pins.

Only automatic selection requests a full catalog refresh. Pins and inheritance use the current catalog; a missing explicit pin fails rather than triggering discovery or falling back. Automatic refresh is deduplicated per parent registry, bounded to five seconds, and cached for fifteen minutes on success or thirty seconds after failure. Offline mode stays cache-only; an empty `PI_OFFLINE` value permits network refresh. Provider and registry availability errors produce stale-catalog notices. Static catalogs need a Pi or provider update before new models can be selected.

Selection is deterministic. A small, version-free naming heuristic recognizes mainline GPT, Claude tiers, Gemini, and Grok across release codenames and provider path aliases. Mini, nano, codex, and pro stay distinct series. General GPT is a strong fit; Sonnet and coding tiers are balanced fits. Unknown and custom families remain eligible as generic fallbacks behind recognized fits. These are quality/cost heuristics, not benchmark claims.

After suitability, selection prefers a supplied thinking level, ranks numeric releases only within comparable series, then considers catalog price. Without a policy or parent thinking level, ranking has no thinking preference; the reported effective level is still explicit. Every finite nonnegative catalog price is valid, including zero; missing or invalid prices are unknown. Dates, context windows, and parameter counts do not determine recency or quality.

Selection and authentication preflight have a ten-second total deadline and respond to stop/shutdown cancellation. Pi's registry authentication facade has no signal parameter, so cancelling stops the caller waiting, not the underlying authentication operation. Late results cannot resume selection or launch a child. These bounds do not cover Pi's later `session.prompt()` availability check, which does not pass a signal to authentication; a stalled SDK-internal check can still delay shutdown.

**Known authentication limitation:** child runtimes are isolated and preserve native and compatibility provider registrations, including per-model headers. Credentials stored only in the parent's runtime or SDK memory store are not shared. A parent can pass authentication preflight while its child cannot authenticate. General propagation needs a supported shared-runtime or authentication-delegation API; converting resolved OAuth or header-only authentication into an API key is not safe.

## Turn limit

Agent frontmatter can cap how many turns a child runs:

```yaml
maxTurns: 40 # positive integer; defaults to subagents.defaultMaxTurns (80)
```

A turn is one model response plus its tool calls. When a child reaches the
limit, it gets one steering message telling it to stop new work and give its
final answer, including what's unfinished. If it is still running three turns
later, it's aborted and reported as failed with `turn limit reached`. The
parent still receives the last output the child wrote. A value that isn't a
positive integer falls back to the default.

## Limits

The extension reads an optional `subagents` object from Pi's global
`settings.json` (`~/.pi/agent/settings.json`). Pi keeps unknown top-level keys
when it rewrites that file, so the object survives settings changes made from
Pi. In a trusted project, `.pi/settings.json` can override individual keys; an
untrusted project's settings are ignored, the same as its agents.

```json
{
  "subagents": {
    "maxTasksPerLaunch": 8,
    "maxConcurrent": 4,
    "maxActiveJobs": 20,
    "defaultMaxTurns": 80
  }
}
```

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `maxTasksPerLaunch` | 8 | 1–32 | Tasks in one parallel launch. Chains aren't capped. |
| `maxConcurrent` | 4 | 1–16 | Children running at once across all jobs; the rest wait queued. |
| `maxActiveJobs` | 20 | 1–100 | Running background jobs in the session. |
| `defaultMaxTurns` | 80 | 1–1000 | Turn limit for agents without `maxTurns`. |

Settings load when the session starts, so run `/reload` after editing them. A
value outside its range, a non-integer, or an unknown key keeps that key's
default and shows a warning. Without a UI, the warning is added to the next
launch result.

Nesting depth is fixed at 1. Children load with `noExtensions` plus only the
guard extensions (and a prompt helper under Gondolin), so they never get the
`subagent` tool and can't launch children of their own.

## Interrupted children

The parent session records each child it launches as small custom entries:
job id, index, agent, cwd, model overrides, the first 2 KB of the task, the
child's native session file once Pi allocates it, and the final state. These
entries aren't sent to the model.

When the parent quits, crashes, or reloads while a child is unfinished, there's
no final state on record. Resuming that parent session (or `/reload`) lists the
child as `interrupted` in `subagent` status, the `/agents` inspector, and the
`interrupted` list in the status snapshot file. Records only count in the
session that made them, so a fork doesn't inherit them. Interrupted children
never restart on their own.

`subagent action=resume id=<job> index=<n>` continues one interrupted child. It
reopens the child's native session, sets the child up the same way a launch
does (current agent definition, tools, guards, trust checks, and the recorded
model overrides re-resolved against the catalog), and sends `message`, or a
default asking it to pick up where it left off and give its final answer. The
child runs as a new background job under the normal limits, its turn count
starts over, and its completion arrives like any other. A resumed chain step
runs alone; later steps don't. Resuming fails if the child already finished or
was stopped by the user, was already resumed, its agent no longer exists, or it
stopped before writing its session file (Pi writes that file after the first
assistant reply). If the resumed run itself fails, it's finished and can't be
resumed again.

## Parent-to-child context contract

Child sessions load with `noExtensions`, `noSkills`, `noPromptTemplates`, and
`noContextFiles` set, so a child never automatically receives the parent
conversation, project or global instruction files (`AGENTS.md`,
`.agents/AGENTS.md`, `.github/copilot-instructions.md`, etc.), loaded skills,
or extension tools. This isolation is intentional; don't work around it by
pasting the parent's full system prompt into a task.

The required contents of a delegated task packet (scope, instruction
pointers, writable paths/ownership, granted permissions, verification and
blocked outcomes) are owned by the
[`delegation` skill](../../../.agents/skills/delegation/SKILL.md). That
contract applies to every launch mode of the `subagent` tool — single,
parallel, and chain alike — not just this file's model-policy mechanics.

## Project trust and child guards

Children follow the parent's project trust. A child gets project trust only
when the parent session trusts its project and the child's cwd is the parent's
workspace, compared after resolving symlinks. Under Gondolin, `/workspace` maps
to the host workspace. Any other cwd, including a subdirectory, is untrusted.
Without trust, the child doesn't load project settings (such as `packages`,
`npmCommand`, or `shellCommandPrefix`) or `.pi/SYSTEM.md`. If the parent has no
trust API, children are untrusted.

Project agents in `.pi/agents/` follow the same rule. If the parent declined
trust, they aren't listed and can't override user agents. A trusted parent can
run them only in its own workspace; a launch that gives a project agent another
cwd is rejected.

Every child loads the `permission-gate` and `protected-paths` extensions, in
native and Gondolin sessions. Children run without a UI, so a dangerous command
is blocked instead of prompting. The guards are best-effort speed bumps, not a
sandbox: they catch common commands and paths, not every way to write a file.

An agent's `tools` list is its real capability boundary. The `second-opinion`
reviewer has no `bash`, so the caller supplies command output. `scout`,
`planner`, and `researcher` keep `bash` for investigation; they're read-only
by instruction only, so delegate to them only what the parent may authorize.
