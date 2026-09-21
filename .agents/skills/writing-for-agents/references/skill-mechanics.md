# Skill mechanics

Read this when creating a new skill, renaming one, changing its frontmatter, or deciding how it should be invoked. It covers packaging facts verified against Pi 0.85.1; the authoring guidance in [SKILL.md](../SKILL.md) is runtime-neutral.

## How a skill actually loads

There is no `Skill` tool. Pi scans skill locations at startup and puts each skill's `name` and `description` into the system prompt. When a task matches, the agent loads the instructions by **reading the file** with the `read` tool (or `bash` when `read` is unavailable), then follows them.

Consequences worth designing around:

- Only the description is always in context. Everything else costs a file read.
- Models do not always load a skill that would help. A precise description is the lever; `/skill:name` is the override.
- References are plain files. Point at them with relative Markdown links from the skill directory, and say when to read them.

## Invocation modes

| Mode | Frontmatter | Who can invoke | Cost |
|------|-------------|----------------|------|
| Model-invoked | omit `disable-model-invocation` | the agent, other skills, and the user via `/skill:name` | description stays in context every turn |
| User-invoked | `disable-model-invocation: true` | the user via `/skill:name` only | no context cost; the user has to remember it exists |

`/skill:name` is explicit user invocation. Arguments after the command are appended to the skill content as `User: <args>`.

Pick user-invoked when the skill should never fire on its own, such as an opt-in session that takes over the conversation. Pick model-invoked when the agent or another skill has to reach it without being told.

With `disable-model-invocation: true`, the description is hidden from the model, so write it for the human reading the command list: one line, no trigger list.

## Frontmatter

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | 1-64 characters, lowercase letters, numbers, and single inner hyphens |
| `description` | yes | max 1024 characters; states what the skill does and when to use it |
| `disable-model-invocation` | no | `true` hides the skill from the system prompt |
| `license` | no | license name or bundled file reference |
| `compatibility` | no | environment requirements, max 500 characters |
| `metadata` | no | arbitrary key-value mapping |
| `allowed-tools` | no | space-delimited pre-approved tools, experimental |

Unknown fields are ignored. A `SKILL.md` without a description is not loaded. Name collisions warn and keep the first skill found.

Pi does not require `name` to match the parent directory, but this repository does: the directory name and the `name` field must be identical so `/skill:name` and the file path agree. Check the match when changing frontmatter or renaming a skill.

## Directory layout

```
my-skill/
├── SKILL.md              # frontmatter + routine path
└── references/           # conditional detail, loaded on demand
    └── workflow.md
```

Reference files must not declare skill frontmatter. In `.agents/skills/`, a nested Markdown file carrying `name` and `description` can be discovered as a separate skill, which registers a phantom skill the user never asked for. Keep references free of frontmatter and start them with a heading instead.

## Writing the description

The description decides whether the skill loads at all.

- Good: `Review diffs, branches, commits, PRs, Copilot comments, and merge readiness.`
- Poor: `Helps with code.`

State the objects and the moments: "Use when the user reports something broken, failing, or slow", not "Use for debugging tasks".

---

Adapted from Matt Pocock's `writing-for-agents` skill, with Pi packaging details from the Pi 0.85.1 skills documentation. See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
