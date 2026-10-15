# Repository instructions

This repository is public.

Do not add secrets, credentials, tokens, private keys, customer data, internal hostnames, internal service names, company-specific runbooks, private documentation, or anything that depends on non-public systems.

Keep examples generic. Use placeholders like `owner/repo`, `example.com`, `$HOME`, and `user@example.com` instead of real company, host, tenant, account, or machine-specific values.

Before committing, scan changes for sensitive or company-specific content. If something is useful but private, keep it outside the repo.

## Checks

Do not add automated tests or test-only helpers to this repository. Use syntax checks and focused manual verification instead.

Run the check for each changed file type and report it under **Checks**:

- Shell: `printf '%s\n' <changed .sh files and dotfiles> | xargs -n1 bash -n` (`bash -n` checks only its first argument; `xargs` exits nonzero if any file fails).
- TypeScript extensions: Node 24 can parse but not typecheck them. Run
  `node -e 'const m=require("node:module"),fs=require("node:fs");for(const f of process.argv.slice(1)){try{m.stripTypeScriptTypes(fs.readFileSync(f,"utf8"),{mode:"transform"})}catch(e){console.error(f+": "+e.message);process.exitCode=1}}' <changed .ts files>`
  and report "syntax only, not typechecked".
- Python: `python3 -c 'import ast,sys;[ast.parse(open(f).read(),f) for f in sys.argv[1:]]' <changed .py files>` (no `__pycache__` left behind).
- JSON: `node -e 'for(const f of process.argv.slice(1))JSON.parse(require("fs").readFileSync(f,"utf8"))' <changed .json files>`.

`node --check` does not parse TypeScript, and the `check` script in `gondolin/package.json` is a stub. Do not cite either as a passing check.
