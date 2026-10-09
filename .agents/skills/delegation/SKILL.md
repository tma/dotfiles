---
name: delegation
description: Delegate work to subagents and supervise them. Use before launching a subagent, when a subagent completes, reports progress, stalls, or fails, or when the user redirects delegated work.
---

# Delegation

The main session is primarily a coordinator: it delegates substantial work, supervises subagents, and keeps ownership of user intent, task routing, decisions, approvals, synthesis, and final acceptance. The global instructions decide *whether* to delegate; this skill owns *how*.

## 1. Split the work into lanes

Use parallel subagents for independent lanes. Give each shared worktree exactly one writer.

**Done when:** every lane is independent of the others, and each worktree has at most one writing child.

## 2. Build a context packet for every child

Children are isolated: a subagent does not automatically receive the parent conversation, project or global instruction files, loaded skills, or extension tools. Every delegated task carries its own self-contained packet:

- a scoped task with concrete acceptance criteria and the expected output
- the relevant instructions, or pointers to accessible files the child must read, not the entire global prompt
- writable paths or worktree, with single-writer ownership when a worktree is shared with other agents
- only the permissions the user has explicitly granted for this task (for example, publishing, committing, or destructive actions)
- how to verify the result, and what a blocked outcome looks like so the child reports it instead of guessing

This contract applies to every launch mode of the `subagent` tool: single, parallel, and chain alike.

**Done when:** each task, read on its own with no parent context, contains all five items.

## 3. Launch asynchronously

Launch delegated work asynchronously and never block the main session waiting for it. After launching, tell the user what is running and remain available.

**Done when:** the launch returned and the user knows which children are running and what each one owns.

## 4. Supervise active children

Treat active delegated agents as work that must be supervised:

- On every new user turn while delegated work is active, inspect live child state first. Report only material progress, completions, failures, stalls, or requests for a decision.
- Treat delivered child completion output as primary evidence when it contains full results. Query live status when the user explicitly asks for status, when details are missing, or when control actions are needed.
- When a stall or completion notification wakes the main session, inspect the relevant status, transcript, or output before summarizing it. Do not just echo the notification.
- When the user redirects active work, steer the existing task instead of launching duplicate replacement work.
- Give brief updates at meaningful milestones. Do not poll in a tight loop or flood the conversation with unchanged status.

**Done when:** every child has completed, failed, or been stopped, and the user has heard each material change.

## 5. Accept or redirect results

Inspect child results and the resulting diff and checks before accepting work, updating todos, or starting dependent work. When evidence is incomplete, reassign or steer the work instead of accepting it.

**Done when:** each accepted result has been checked against its acceptance criteria, and the synthesis to the user comes from the main session.

## Blocked outcomes

When a child reports it is blocked, fails, or stalls, decide in the main session: steer it with the missing context, reassign the lane, or ask the user when the decision needs their intent or approval. Do not fill the gap by guessing on the child's behalf.
