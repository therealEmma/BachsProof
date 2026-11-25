# @bachsproof/cli

**Beyond webhook delivery. Verify financial correctness.**

Package-installable CLI onboarding for BachsProof, a financial correctness
testing framework for applications integrating Bachs.

    pnpm add -D @bachsproof/cli
    pnpm exec bachsproof init
    pnpm exec bachsproof test

`bachsproof init` creates a small configuration and test suite in the independent
application repository:

- `bachsproof.config.mjs` for the provider, webhook target, signing secret,
  payment preparation, verification, and polling settings;
- `tests/bachsproof.test.mjs` with all 15 supported scenario definitions;
- `tests/bachsproof.setup.mjs` for the optional `createPayment(context)` callback;
- `tests/bachsproof.verify.mjs` for the `verify(reference, context)` callback.

The generated setup and verifier templates fail until implemented. BachsProof does
not invent application references or treat expected values as financial proof.

The target application does not need BachsProof routes, controllers, services, or
production instrumentation. It only needs a reachable webhook URL. The
application owns test payment preparation, isolation, cleanup, and committed
state access.

Real application references are the default. Use `createPayment` for fresh test
records, explicit `reference` or `references` for manual fixtures, and
`syntheticReferences: true` only for isolated adapter/HTTP fixture tests.

The CLI runs configured scenarios sequentially. Delivery waves inside a
concurrency scenario remain concurrent. `--name` runs one exact test name and
`--json` emits machine-readable reports:

    pnpm exec bachsproof test --name "underpaid payment"
    pnpm exec bachsproof test --json

Add `requireFinancialVerification: true` when the suite must fail unless the
callback has observed committed financial state. Without a callback, BachsProof
can still test HTTP delivery, but it reports the run as financially unverified.

For optional controlled concurrency testing, configure a checkpoint and use
`@bachsproof/sdk` in an explicitly enabled test build. Ordinary black-box HTTP
concurrency is not deterministic race-condition coverage.

See the repository [quickstart](../../docs/quickstart.md) and
[CLI guide](../../docs/cli.md) for the complete workflow.
