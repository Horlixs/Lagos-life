# Safe job lifecycle helpers

This branch adds an isolated, adapter-agnostic lifecycle module and Node.js tests.
It does **not** change the existing funding dispatcher or call the live game API.

## Run the tests

From the repository root, with Node.js installed:

```bash
node --test scripts/safe-job-lifecycle.test.mjs
```

## Contract

- Automatic recovery is limited to explicitly `paused` or `interrupted` jobs.
- Jobs marked as server-refused or policy-blocked are not eligible for automatic resume.
- Completion requires confirmed progress to meet the selected target.
- Cancel and reset increment `runToken`, invalidating a stale worker's token.
- These helpers are pure state transitions: they perform no network requests or background work.

## Integration requirements before use

1. Persist state durably; do not rely on process memory alone.
2. Use an atomic compare-and-set update in the persistence layer when claiming work or changing `runToken`.
3. Re-read the current state and validate the worker token immediately before each side effect.
4. Keep server refusals/policy blocks terminal until explicitly reviewed; do not relabel them as transient interruptions.
5. Use a mock adapter for integration tests first.

The existing live funding dispatcher is intentionally not wired to this module in this change. That avoids unintentionally restarting its current external transfer loop.
