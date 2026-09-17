# Local Pi

A separate Pi profile for talking to stuff on the local network. It only sees
LM Studio models and the tools in this directory. Launch it with `pi-local`.

This is not the coding agent. Cloud auth, skills, and filesystem tools stay
out of the session.

## Setup

```bash
# from this repository
./install.sh

export PAPERLESS_URL="http://paperless.example.local:8000"
export PAPERLESS_TOKEN="..."   # Paperless admin → API token

# LM Studio listening on localhost:1234
# optional: export LM_STUDIO_URL="http://127.0.0.1:1234"
pi-local
```

`PAPERLESS_URL` has to resolve to a local address (RFC1918, loopback,
Tailscale). Do not put the real URL or token in this repository.

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
