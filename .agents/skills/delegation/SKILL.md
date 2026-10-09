---
name: delegation
description: Delegate work to subagents and supervise them. Use before launching a subagent, when a subagent completes, reports progress, stalls, or fails, or when the user redirects delegated work.
---

# Delegation

The main session is primarily a coordinator: it delegates substantial work, supervises subagents, and keeps ownership of user intent, task routing, decisions, approvals, synthesis, and final acceptance. The global instructions decide *whether* to delegate; this skill owns *how*.

## 1. Choose the smallest shape

Split the work into the fewest lanes that cover it:

- Handle a lane with a direct tool call when its target is already known, such as a named file to read or a single command to run.
- Give each distinct question or code seam its own child. Batch small edits of the same kind into one child.
- Run lanes in parallel only when they are read-only, or when the writers own disjoint files and the main session has already decided the interfaces they share. Otherwise run writers in sequence. Give each shared worktree exactly one writer.

**Done when:** each lane has a distinct output, no two lanes can make the same decision, and each worktree has at most one writing child.

## 2. Build a context packet for every child

Children are isolated: a subagent does not automatically receive project or global instruction files, loaded skills, or extension tools, and by default not the parent conversation. Every delegated task carries its own self-contained packet:

- the goal and why it matters
- a scoped task with concrete acceptance criteria and the expected output
- what is already known or ruled out, and decisions already made that the child must not revisit
- your own synthesis of the work: the files, lines, and specific change, never "based on your findings, fix it"
- the relevant instructions, or pointers to accessible files the child must read, not the entire global prompt
- writable paths or worktree, with single-writer ownership when a worktree is shared with other agents
- only the permissions the user has explicitly granted for this task (for example, publishing, committing, or destructive actions)
- how to verify the result, and what a blocked outcome looks like so the child reports it instead of guessing

This contract applies to every launch mode of the `subagent` tool: single, parallel, and chain alike.

Start each child fresh by default. Fork it from this conversation (in Pi, `context: "fork"`) only when it needs session decisions or evidence that would cost more to summarize than to inherit, such as continuing an investigation. Second-opinion reviews, independent research, and adversarial checks always start fresh, because a reviewer that has read the parent's reasoning is no longer independent. A forked task still carries the full packet, including scope, writable paths, and permissions.

**Done when:** each task, read on its own with no parent context, contains every item above, and every forked task continues work rather than reviewing it.

## 3. Launch asynchronously

Launch delegated work asynchronously and never block the main session waiting for it. After launching, tell the user what is running and remain available.

**Done when:** the launch returned and the user knows which children are running and what each one owns.

## 4. Supervise active children

Treat active delegated agents as work that must be supervised:

- On every new user turn while delegated work is active, inspect live child state first. Report only material progress, completions, failures, stalls, or requests for a decision.
- Treat delivered child completion output as primary evidence when it contains full results. Query live status when the user explicitly asks for status, when details are missing, or when control actions are needed.
- When a stall or completion notification wakes the main session, inspect the relevant status, transcript, or output before summarizing it. Do not just echo the notification.
- Report a child as running until its completion arrives. Never predict or summarize a result it has not delivered.
- When the user redirects active work, steer the existing task instead of launching duplicate replacement work.
- Give brief updates at meaningful milestones. Do not poll in a tight loop or flood the conversation with unchanged status.

**Done when:** every child has completed, failed, or been stopped, and the user has heard each material change.

## 5. Accept or redirect results

Treat a child's summary as a claim, not as evidence. Before accepting a writer's work, updating todos, or starting dependent work, read its diff and the raw output of its verification command. Before acting on a finding, open the cited `file:line`. When evidence is incomplete, reassign or steer the work instead of accepting it.

**Done when:** each accepted result has been checked against its acceptance criteria using the diff, command output, or cited source, and the synthesis to the user comes from the main session.

## Blocked outcomes

When a child reports it is blocked, fails, or stalls, decide in the main session: steer it with the missing context, reassign the lane, or ask the user when the decision needs their intent or approval. Do not fill the gap by guessing on the child's behalf.

Change something before relaunching: add the missing context, split the task, or choose a stronger model or higher thinking level. Never rerun the same brief unchanged.
