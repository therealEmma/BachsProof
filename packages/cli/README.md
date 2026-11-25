# payproof CLI

The `payproof` command runs PayProof against an existing application's webhook
URL. It is black-box by default: the target does not need PayProof routes,
controllers, services, or checkpoint instrumentation.

For a first integration, follow the repository's
[beginner quickstart](../../docs/quickstart.md).

```bash
pnpm add -D @payproof/cli
pnpm exec payproof init
PAYPROOF_TARGET_URL=http://127.0.0.1:3000 pnpm exec payproof test
```

`payproof init` creates `payproof.config.mjs`,
`tests/payproof.test.mjs`, an opt-in `tests/payproof.setup.mjs`, and a hard-fail
`tests/payproof.verify.mjs` template. The generated test lists all supported Bachs
duplicate, lifecycle, validation, rejection, underpayment, and failed-payment
scenarios with configurable amount/currency values. Enable `createPayment` in
the generated config to prepare fresh application payment records automatically.
It intentionally warns that black-box delivery is not deterministic
race-condition coverage and does not prove committed financial correctness.

Run the whole generated suite or one scenario by name:

```bash
pnpm exec payproof test
pnpm exec payproof test --name "underpaid payment"
```

Real application references are required by default. Implement
`createPayment({ scenario, amountMinor, currency, paymentIndex, paymentCount })`
in `tests/payproof.setup.mjs` and uncomment it in the generated config. PayProof
calls it only for selected scenarios, creates two independent references for
`concurrent-unique-payments`, validates returned values, and sends no webhook
when preparation fails. Manual `reference`/`references` test fields remain
supported, and `PAYPROOF_USE_SYNTHETIC_REFERENCES=true` is available only for
isolated fixture tests. Positional `PAYPROOF_REFERENCES` configurations remain
usable when translated into the test definitions, but are no longer generated.

See the repository [scenario matrix](../../docs/scenarios.md) for expected
HTTP outcomes and financial assertions.

Add a test-side `verify(reference, context)` callback to query the application's own
committed database state when financial correctness should be asserted. This
does not require changing the production webhook code. Set
`requireFinancialVerification: true` to fail when the callback or an HTTP state
inspection endpoint is absent.

The context includes the scenario, expected outcome, related event IDs, and
delivery records. Those fields describe the test; only the callback's observed
committed state can establish the financial result. The CLI prints a
consolidated summary with delivery, financial-verification, violation, and
duration counts.

For deeper race testing, configure `checkpoint` and instrument the target only
in its explicit test environment with `@payproof/sdk`:

```ts
await checkpoint("after-idempotency-check", { key: payment.reference });
```

That is an optional white-box mode. The CLI never implies that ordinary
black-box HTTP delivery is deterministic concurrency coverage.
