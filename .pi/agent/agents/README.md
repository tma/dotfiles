# Subagent model policies

Agent frontmatter can select a model at launch time instead of pinning a release:

```yaml
model: auto:balanced # auto:cheap, auto:balanced, or auto:strong
thinking: medium     # off, minimal, low, medium, high, xhigh, or max
provider: openrouter # optional exact provider constraint
family: claude-opus  # optional normalized token-sequence constraint
```

Explicit `provider/model[:thinking]` pins still work. A malformed or missing pin, unavailable authentication, or an empty constrained automatic selection fails the child. Automatic and pinned policies never fall back to the parent model. An older agent with no model policy inherits the parent model for compatibility, and the selection reason says so.

The `subagent` tool accepts `model`, `thinking`, `provider`, and `family` on a single launch, as shared defaults for parallel tasks or chains, and on each task or chain step. Precedence is step/task override, shared launch default, then agent frontmatter. Thinking uses the same order, followed by a pin's `:thinking` suffix and then the parent level. Pi clamps the requested level to the selected model's supported levels and reports both the effective level and the reason.

Subagent policies intentionally use all available provider catalogs, independently of the main session's `enabledModels` / `scopedModels` cycling list. Restrict subagents with `provider`, `family`, or explicit pins.

Only automatic selection requests a full catalog refresh. Pins and inheritance use the current catalog; a missing explicit pin fails rather than triggering discovery or falling back. Automatic refresh is deduplicated per parent registry, bounded to five seconds, and cached for fifteen minutes on success or thirty seconds after failure. Offline mode stays cache-only; an empty `PI_OFFLINE` value permits network refresh. Provider and registry availability errors produce stale-catalog notices. Static catalogs need a Pi or provider update before new models can be selected.

Selection is deterministic. A small, version-free naming heuristic recognizes mainline GPT, Claude tiers, Gemini, and Grok across release codenames and provider path aliases. Mini, nano, codex, and pro stay distinct series. General GPT is a strong fit; Sonnet and coding tiers are balanced fits. Unknown and custom families remain eligible as generic fallbacks behind recognized fits. These are quality/cost heuristics, not benchmark claims.

After suitability, selection prefers a supplied thinking level, ranks numeric releases only within comparable series, then considers catalog price. Without a policy or parent thinking level, ranking has no thinking preference; the reported effective level is still explicit. Every finite nonnegative catalog price is valid, including zero; missing or invalid prices are unknown. Dates, context windows, and parameter counts do not determine recency or quality.

Selection and authentication preflight have a ten-second total deadline and respond to stop/shutdown cancellation. Pi's registry authentication facade has no signal parameter, so cancelling stops the caller waiting, not the underlying authentication operation. Late results cannot resume selection or launch a child. These bounds do not cover Pi's later `session.prompt()` availability check, which does not pass a signal to authentication; a stalled SDK-internal check can still delay shutdown.

**Known authentication limitation:** child runtimes are isolated and preserve native and compatibility provider registrations, including per-model headers. Credentials stored only in the parent's runtime or SDK memory store are not shared. A parent can pass authentication preflight while its child cannot authenticate. General propagation needs a supported shared-runtime or authentication-delegation API; converting resolved OAuth or header-only authentication into an API key is not safe.

See [tests/README.md](../tests/README.md) for offline checks.
