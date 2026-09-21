# Comparing alternative designs

Read this from the `design-review` skill when a decision is consequential enough that the first idea should not win by default: a new interface others will build on, a data model, a migration path, anything expensive to reverse.

Skip it for decisions you can reason through directly. Two or three alternatives is the usual shape, not a rule.

## 1. Write the brief

Before delegating anything, write one factual brief that every explorer receives unchanged:

- The decision and its boundaries.
- The constraints that bind, and which ones are hard.
- The relevant file paths, existing interfaces, call sites, and data shapes.
- The vocabulary the repository already uses for these concepts.
- What must keep working: current callers, stored data, public behavior.

Keep opinions out of it. A brief that hints at a preferred answer produces variations on one design.

## 2. Explore in parallel

Delegate to the host's native read-only subagents, launched asynchronously so exploration runs in parallel. In Pi, use the `subagent` tool with `tasks` for parallel delegation.

Give each one the same brief and a different constraint. Useful ones:

- **Smallest interface** — the fewest entry points that still cover the callers.
- **Most flexible** — accommodate the extensions and variations that look likely.
- **Easiest common case** — make the dominant caller trivial, even at some cost to the rare one.
- **Cheapest migration** — minimize what has to change at existing call sites and in stored data.
- **Boundary-first** — put the seam where an external dependency can be swapped or faked.

Each explorer returns:

1. The interface: entry points, parameters, return values, error modes, ordering and invariants.
2. A usage example from a real call site in the brief.
3. What the implementation hides, and what the caller still has to know.
4. What it would take to migrate to it from the current code.
5. Where it is weak.

Constraints on every explorer: read-only, no file edits, no commands that change state, no recursive delegation, no external model CLIs. They return options; they do not pick one.

## 3. Compare and choose in the main session

Comparison and the recommendation stay with you. Present each design briefly, then compare across:

- **Interface size against behavior covered** — how much a caller has to learn for what they get.
- **Hidden complexity** — what the caller no longer has to think about, and what leaks through anyway.
- **Locality** — when this changes later, how many places have to change with it.
- **Testability** — what can be verified through the interface, and what needs a fake or a live dependency.
- **Migration cost** — call sites, stored data, compatibility windows, and whether it can ship incrementally.
- **Reversibility** — how hard it is to back out after a month in production.

End with a recommendation and the reason. Propose a hybrid when parts of two designs fit together better than either alone. Say what would change your mind.

The user picks. Record the choice in the conversation; writing it to a file is a separate request.

---

Adapted from Matt Pocock's `codebase-design` skill, specifically `DESIGN-IT-TWICE.md`, which is itself based on the "design it twice" idea in John Ousterhout's *A Philosophy of Software Design*. See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
