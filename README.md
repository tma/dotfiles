# dotfiles

## Install

```sh
./install.sh
```

The installer links the items listed at the top of `install.sh` into `$HOME`, `~/.pi/agent`, and `~/.pi/local`. Other files in the checkout, like `.env` and sessions, aren't linked.

Pi extension directories with an `index.ts`, `index.js`, or `package.json`, like `gondolin`, are linked as one directory so Pi can load their `node_modules/` and other runtime files. Elsewhere, `node_modules/` isn't linked.

It doesn't overwrite anything. If a file, directory, or symlink already exists where a link should go and doesn't already point at this repository, the installer skips it, prints a warning, and exits nonzero. That includes an existing extension directory with the same name, which is left alone instead of merged. Move the existing item aside and rerun. Rerunning is safe; existing links are left as they are.

The optional OpenCode and pi installs in Codespaces, and the Gondolin dependency install, only warn when they fail.
