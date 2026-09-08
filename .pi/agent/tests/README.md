# Subagent policy tests

Run the resolver tests with Node.js built-in TypeScript stripping:

```sh
node --experimental-strip-types --test .pi/agent/tests/model-selection.test.ts
```

Run resolver and launcher smoke tests together:

```sh
node --experimental-strip-types --test .pi/agent/tests/*.test.ts
```

The launcher tests also need Node's `node:module.stripTypeScriptTypes` API. They execute the actual launcher functions with fake session, storage, and sandbox boundaries. No model calls are made.

Real-Pi integration tests skip with a setup message unless `PI_TEST_NODE_MODULES` is set. Point it at an existing external `node_modules` directory containing `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and their runtime dependencies:

```sh
PI_OFFLINE=1 PI_TEST_NODE_MODULES=/path/to/node_modules \
  node --experimental-strip-types --test .pi/agent/tests/*.test.ts
```

Integration tests report the supplied Pi version rather than pinning a patch release. A configured invalid path or incompatible API fails the run. They use memory credentials/catalogs and a temporary external agent directory, with no model calls or repository authentication/session files.

The runtime-only credential test reproduces a known unresolved limitation: parent authentication succeeds, but the independent child has no credential. Its passing assertion documents the blocker; it does not establish support for credential propagation.
