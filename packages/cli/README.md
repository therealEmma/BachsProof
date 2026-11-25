# @payproof/cli

Package-installable CLI onboarding for black-box payment correctness testing.

    pnpm add -D @payproof/cli
    pnpm exec payproof init
    pnpm exec payproof test

`payproof init` creates a small configuration and test suite in the independent
application repository:

- `payproof.config.mjs` for the provider, webhook target, signing secret,
  payment preparation, verification, and polling settings;
- `tests/payproof.test.mjs` with all 15 supported scenario definitions;
- `tests/payproof.setup.mjs` for the optional `createPayment(context)` callback;
- `tests/payproof.verify.mjs` for the `verify(reference, context)` callback.

The generated setup and verifier templates fail until implemented. PayProof does
not invent application references or treat expected values as financial proof.

The target application does not need PayProof routes, controllers, services, or
production instrumentation. It only needs a reachable webhook URL. The
application owns test payment preparation, isolation, cleanup, and committed
state access.

Real application references are the default. Use `createPayment` for fresh test
records, explicit `reference` or `references` for manual fixtures, and
`syntheticReferences: true` only for isolated adapter/HTTP fixture tests.

The CLI runs configured scenarios sequentially. Delivery waves inside a
concurrency scenario remain concurrent. `--name` runs one exact test name and
`--json` emits machine-readable reports:

    pnpm exec payproof test --name "underpaid payment"
    pnpm exec payproof test --json

Add `requireFinancialVerification: true` when the suite must fail unless the
callback has observed committed financial state. Without a callback, PayProof
can still test HTTP delivery, but it reports the run as financially unverified.

For optional controlled concurrency testing, configure a checkpoint and use
`@payproof/sdk` in an explicitly enabled test build. Ordinary black-box HTTP
concurrency is not deterministic race-condition coverage.

See the repository [quickstart](../../docs/quickstart.md) and
[CLI guide](../../docs/cli.md) for the complete workflow.
