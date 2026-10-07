# Local Pi

A separate Pi profile for talking to stuff on the local network. It only sees
LM Studio models and the tools in this directory. Launch it with `pi-local`.

This is not the coding agent. Cloud auth, skills, and filesystem tools stay
out of the session.

## What `pi-local` enforces

- **LM Studio only.** `local-only.ts` replaces every built-in Pi provider
  with a blocker that has no models and never resolves credentials. Cloud API
  keys in your environment or `auth.json` can't pick, restore, or send to a
  cloud model. `--model openai/...` fails, and a resumed cloud session falls
  back to LM Studio. If LM Studio is down or has no chat models, there's no
  model and prompts fail locally.
- **No project resources.** `pi-local` always passes `--no-approve`, loads its
  own extensions with explicit `--extension` paths under `--no-extensions`,
  and refuses `--approve`/`-a`. Built-in extensions (MCP, llama.cpp, codemode)
  stay off. A user `--no-extensions` can't drop the guard.
- **No proxies.** `pi-local` sets `NO_PROXY=*` for Pi, so an inherited
  `HTTP_PROXY`/`HTTPS_PROXY` can't route prompts off the machine.
- **IP-literal LM Studio URL.** `LM_STUDIO_URL` must be a local IP such as
  `http://127.0.0.1:1234` or `http://[::1]:1234`. Hostnames, including
  `localhost`, are rejected because Pi's chat client resolves names on its own
  and a name could start pointing at a public address.

This doesn't cover providers you add to `models.json` or extensions you load
with `-e`. Those can use other endpoints or register additional providers.

## Setup

```bash
# from this repository
./install.sh

# ./.env in the directory you launch from (not in git)
# PAPERLESS_URL=http://paperless.example.local:8000
# PAPERLESS_TOKEN=...
# LM_STUDIO_URL=http://127.0.0.1:1234

# LM Studio listening on localhost:1234
pi-local
```

`pi-local` doesn't source `.env` in your shell. Pi reads it as data from the
launch directory, or from `PI_LOCAL_ENV` when that's set (exported or not).
Startup notifies the path it used. The rules:

- Only `PAPERLESS_URL`, `PAPERLESS_TOKEN`, and `LM_STUDIO_URL` are read.
  Other keys are ignored.
- Variables already in the environment win over `.env`.
- `KEY=value` lines, with an optional `export `. Lines starting with `#` are
  comments. One pair of matching outer quotes is removed. Nothing is expanded:
  `$`, backticks, `#`, and backslashes in a value stay literal.
- Values load once per process. Restart `pi-local` after editing `.env`;
  `/reload` keeps the old values.

Paperless tools are always registered. Calls fail until `PAPERLESS_URL` and
`PAPERLESS_TOKEN` are set. `PAPERLESS_URL` may be a domain as long as it
resolves to a local address (RFC1918, loopback, Tailscale). Public records
on the same name are ignored; the request is pinned to a local IP. Do not
put the real URL or token in this repository.

Models come from LM Studio at startup (`/api/v0/models`, then `/v1/models`).
`models.json` has no hardcoded model list. `/reload` picks up models you
load later.

## Current tools

- `paperless_search` / `paperless_get` — read-only Paperless-ngx

## Later

Other LAN sources that fit this profile:

- **Balance** — finance data (accounts, balances, transactions)
- **CalDAV** — calendar events
- **Home Assistant** — lights, climate, sensors, and the rest of the house
- **Immich** — photos (search, albums, metadata; not a dump of binaries)

Same rules as Paperless: env-based credentials, host allowlist, read-only
unless there is a clear reason to write. No public web unless we add that
on purpose.
