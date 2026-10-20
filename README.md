# dotfiles

## Install

```sh
./install.sh
```

The installer links the items listed at the top of `install.sh` into `$HOME`, `~/.pi/agent`, `~/.pi/local`, and `~/.pi/work`. Other files in the checkout, like `.env` and sessions, aren't linked.

Pi extension directories with an `index.ts`, `index.js`, or `package.json`, like `gondolin`, are linked as one directory so Pi can load their `node_modules/` and other runtime files. Elsewhere, `node_modules/` isn't linked.

It doesn't overwrite anything. If a file, directory, or symlink already exists where a link should go and doesn't already point at this repository, the installer skips it, prints a warning, and exits nonzero. That includes an existing extension directory with the same name, which is left alone instead of merged. Move the existing item aside and rerun. Rerunning is safe; existing links are left as they are.

The optional OpenCode and pi installs in Codespaces, and the Gondolin dependency install, only warn when they fail.

## Separate Pi work profile

Run `./install.sh`, then use `pi-work` from the project directory. The installer links the regular profile's `extensions/` and subagent definitions in `agents/` into `~/.pi/work`. Settings, providers, models, saved credentials, and sessions stay separate. Packages declared in the regular profile's settings aren't shared automatically.

Use `/login` and `/model` inside `pi-work` to choose the project's provider and model. Its settings live in `~/.pi/work/settings.json`; custom providers and models belong in `~/.pi/work/models.json`. Continue with `pi-work -c`, and use `/session` to check the session path.

Gondolin stays off in `pi-work`. The launcher sets `PI_DISABLE_GONDOLIN`, so that profile does not start a micro-VM even though it links the shared extensions. Restart `pi-work` after pulling this change; `/reload` in an already-open session does not see the new variable.

The launcher also passes `--tools +codemode` unless you already pass `--tools`, `--no-tools`, or `--no-extensions`. That turns codemode on without sharing settings. `pi-local` still leaves it off.

Set `PI_WORK_DIR` to an absolute path for both installation and launch to use another profile. For example, run `PI_WORK_DIR="$HOME/.pi/another-project" ./install.sh`, then `PI_WORK_DIR="$HOME/.pi/another-project" pi-work`. Environment API keys, shared skill discovery, and project instructions still apply; this separates Pi's profile and session storage, not filesystem access.

Shared skills belong in `~/.agents/skills`; the installer no longer deploys `~/.pi/agent/skills`. Existing manually installed skills there are left alone and aren't linked into the work profile.

## Pi status panel

Pi opens a right-hand status panel in Rex. Toggle it with `/status` or `Ctrl+Shift+S`. Rex uses 35% of the split and the title `Status`, without moving focus away from Pi.

With the panel open, Pi hides its duplicate footer. The panel shows the selected thinking level beside the model name. Toggle the panel off to restore the footer.

Closing the pane directly in Rex also restores the footer.

Run `/reload` or restart Pi after changing these extensions.
