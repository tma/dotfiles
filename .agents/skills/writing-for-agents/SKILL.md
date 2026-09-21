---
name: writing-for-agents
description: Author or edit agent-facing instructions. Use when creating or changing a skill, a skill reference file, AGENTS.md, or other instructions an agent loads.
---

# Writing for Agents

Use this skill when the document you are writing is read by an agent rather than a person: a `SKILL.md`, a reference file a skill points at, `AGENTS.md`, or a repository instruction file.

The goal is a document that produces the same process every run. Optimize for reliable behavior, not for word count.

For frontmatter fields, invocation modes, and how skills are discovered and loaded, read the [skill mechanics reference](./references/skill-mechanics.md).

## Authoring workflow

### 1. Fix the scope and the trigger

Write one sentence naming what the document covers and one sentence naming when the agent should reach for it. For a skill, the `description` is that trigger: it is the only part always in context, so it must name the distinct cases that should load the file.

- List genuinely different triggers, not synonyms for one trigger.
- Name the objects the agent will be holding: "PR URL", "staged diff", "merge conflict", "Kusto cluster".
- Keep out identity the body already carries.

**Done when:** you can say which requests should load the document and which should not, and the description contains the words a user would actually use.

### 2. Inspect existing behavior before changing anything

Read the file you are editing in full, plus its references and any neighbor that already states the same rule. Grep the other skills for the rule you are about to add.

- If a rule already exists elsewhere, decide who owns it before writing a second copy.
- If the change removes or reshapes a rule, name the behavior that rule protects.

**Done when:** you can list every place the affected behavior is currently stated.

### 3. Write ordered steps with observable done conditions

Put the routine path in the main file as numbered steps in execution order. End each step with a condition the agent can check.

- Checkable: "every changed file read in full", "`gh pr view` returned a PR number", "the failing test ran and failed".
- Not checkable: "understand the change", "be thorough".
- State the useful outcomes the step can produce, including blocked ones: what to report when the tool is missing, authentication fails, or the input is empty.

**Done when:** each step says what the agent does, how it knows the step finished, and what it reports when the step cannot finish.

### 4. Push branch-specific detail behind conditional pointers

Keep the routine flow in `SKILL.md`. Move material that only some runs need into `references/` and point at it with the condition that should trigger the read.

- Write the pointer as a condition plus a link: "If the user asks to process Copilot comments, read the Copilot review workflow" followed by the relative link to that file.
- Inline what every run needs. A pointer that fires on every run is a split that costs a file read for nothing.
- When the agent must read a reference before acting, word the pointer as an obligation and say what goes wrong if it skips: "Read X before publishing; it owns the approval rules."

**Done when:** the main file reads as one coherent routine path, and each reference has a stated trigger condition.

### 5. Give every rule one owner

Each reusable policy lives in exactly one place. Other documents state the binding requirement in one line and point at the owner.

- Owner file holds the detail: the format, the commands, the edge cases.
- Pointing files keep the obligation visible: "Before writing a commit message, apply the `writing-voice` skill and its curated profile."
- Deduplicating must not weaken a requirement. If the short version drops a constraint that changes behavior, the short version is wrong.

**Safety rules are not duplication.** Hard gates (approval before publishing, no secrets in output, read-only reviewers, no destructive commands without confirmation) stay where the agent is standing when it could break them, even if another file also states them. Never prune a guardrail because a general rule already covers it, and never bury one inside an optional reference.

**Done when:** each reusable policy has one owner, every other mention is a one-line pointer, and every hard gate is visible on the path where it applies.

### 6. Validate and preserve behavior

Read the [validation checklist](./references/validation.md) before finishing an edit. It covers behavior preservation, which structural checks apply where, and the manual scenarios worth walking through.

**Done when:** the relevant available checks are complete, any unchecked parts are reported, and you can name, for every behavior the old document produced, either the line that still produces it or the reason it was deliberately dropped.

## Style that survives a run

- Prefer the positive instruction: "stage the specific files for this topic" beats "don't stage everything". Keep the prohibition when the gate is the point ("never force push a shared branch"), and pair it with the positive action.
- Use the project's existing vocabulary. A term the repository already uses recruits everything the agent has read; a new coined term has to be defined and then kept consistent.
- Keep one meaning in one place. Repeating a term is fine; repeating a policy is maintenance debt.
- Prune lines that no longer bear on the task: stale commands, exposition, or branches that moved into a reference. Shorter documents stay accurate longer.
- Shipping less text is not the goal. Cut a line when it does not change behavior or when it is stale, not to hit a token target.

## Optional: session retrospectives

When the user asks what to improve after a session, read the [session retrospective reference](./references/session-retrospectives.md). It turns observed friction into proposals: deterministic rules become checks, judgment calls become documentation, and nothing is written until the user picks.

---

Parts of this skill are adapted from Matt Pocock's `skills` repository. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
