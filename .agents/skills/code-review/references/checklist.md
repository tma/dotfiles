# Review Checklist

Apply this checklist to each changed file. Focus on concrete issues visible in
the diff or surrounding code. Do not invent problems.

## Correctness

- Logic errors, off-by-one mistakes, nil/null dereferences, missing returns.
- Race conditions or unsafe concurrent access.
- Incorrect error handling: swallowed errors, wrong error type, missing cleanup.
- Edge cases: empty input, zero values, boundary conditions.
- Behavior changes that conflict with the PR description or linked issues.

## Security

- Injection risks: SQL, command, template, path, or shell injection.
- Secrets or credentials in code, tests, fixtures, or logs.
- Unsafe deserialization or path traversal.
- Missing authentication or authorization checks.
- Overly permissive file, network, token, or credential access.

## Reliability

- Resource leaks: unclosed files, connections, goroutines, channels, timers.
- Missing timeouts, cancellation, or context propagation.
- Unbounded growth: maps, slices, queues, channels, caches, retries.
- Error messages that lose useful context.
- Retry behavior that can amplify load or hide failures.

## Style and maintainability

- Naming that is unclear or inconsistent with the codebase.
- Dead code or commented-out code being added.
- Missing, stale, or misleading comments.
- Public APIs that are broader or more complicated than needed.
- Duplicated logic where a small shared helper would be clearer.

## Performance

Only flag performance when it is clearly problematic or in a hot path.

- O(n²) or worse behavior on expected large inputs.
- Unnecessary allocations in loops or request paths.
- Missing indexes for new queries.
- N+1 query patterns.
- Avoidable network calls, database calls, or serialization work.

## Docs

Check if README or documentation files need updates based on the changes.
Flag missing docs for:

- new features
- changed behavior
- new config options
- CLI flags
- API endpoints
- environment variables
- operational runbooks or dashboards

## Tests

Check whether new or changed code paths are covered.

Look for tests for:

- happy path behavior
- empty input
- error paths
- boundary values
- permission or auth failures
- integration/system coverage for critical flows

If coverage is missing, name the specific path or file that needs a test.

## Finding quality bar

For each finding:

- quote the relevant code or cite file + line range
- explain what goes wrong concretely
- suggest a fix when possible
- assign the lowest severity that still gets the issue addressed

Avoid vague findings like “this could be a problem.” Say what fails, when, and
why it matters.

If the diff is clean, say so. A clean review is better than invented feedback.
