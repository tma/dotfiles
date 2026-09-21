# Session retrospectives

Read this when the user asks what to improve after a session: "retro", "what should we change", "why was that painful".

The output is a set of proposals about the agent's environment. Nothing is changed until the user picks.

## Steps

1. **Collect evidence of friction.** Use the current session unless the user names another one. Look for concrete moments: a file the agent could not find, a mistake a check would have caught, a rule it broke, a tool call that burned context for little return, a piece of information it never had access to. An improvement with no moment behind it is speculation.

2. **Inspect what already exists.** Before proposing a check, read the repository's own scripts (`package.json`, build configuration, CI workflow) and instruction files. A check that already exists but is unwired, silently failing, or never run is a better finding than a new one you invent. Note when a repository has no linting, typechecking, or test command at all.

3. **Split deterministic from judgment.** This decides where the fix belongs.
   - **Deterministic** — a fixed pattern, a banned call, an import shape, a file location, a formatting rule. These go into a test, a lint rule, a typecheck, or a pre-commit hook. Prefer building the check over writing a sentence asking the agent to remember.
   - **Judgment** — cross-file consistency, "matches the surrounding style", design fit, tone. These go into documentation: a skill, a reference, or the review guidance. No check can substitute for them.

4. **Check the instruction files for load-bearing lines.** Large instruction files thin out attention. Look for lines that no longer match the repository, rules that belong in a check, and rules that belong in a skill that only some tasks load. Removing a line is a proposal like any other: say what behavior it was producing.

5. **Propose, ranked.** Present candidates worst-friction-first. For each one: the moment that motivated it, the proposed change, where it would live, and what it would cost. Ask which to implement.

## Boundaries

- Do not write memory, handoff, or decision files as a byproduct of the retrospective. The `context-memory` skill owns that policy: continuity lives in the session, and durable documents are created only when they serve the project.
- Do not change instruction files, skills, or configuration during the retrospective. Proposals first, edits after the user picks.
- Keep the output in the conversation unless the user asks for a document.

---

Adapted from Matt Pocock's in-progress `retro` skill. See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
