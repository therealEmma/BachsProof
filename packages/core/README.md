# `@bachsproof/core`

The provider-independent test runner used by BachsProof.

Use this package when you want to run payment scenarios from Vitest, Jest, or a
custom test script instead of the CLI. The runner sends a test event to your
existing webhook, records the response, calls your `verify()` callback, and
checks the financial rules.

```ts
import { BachsProof } from "@bachsproof/core";
import { bachsAdapter } from "@bachsproof/bachs";

const runner = new BachsProof({
  provider: bachsAdapter({ mode: "mock" }),
  target: {
    baseUrl: "http://127.0.0.1:3000",
    webhookPath: "/webhooks/bachs"
  },
  verify: (reference) => readCommittedState(reference),
  financialVerification: {
    completionDeadlineMs: 10_000,
    pollIntervalMs: 25,
    negativeObservationWindowMs: 250
  }
});

const result = await runner.run({
  scenario: "concurrent-duplicate-credit",
  reference: "isolated-test-payment-001",
  amountMinor: 500_000,
  currency: "NGN",
  concurrency: 2
});

if (!result.passed) process.exitCode = 1;
```

`readCommittedState()` is application code. It must read the same isolated
database used by the webhook worker. It must return `reference`, `creditCount`,
`creditedAmountMinor`, and `currency`. Do not return the expected values from
the test as a shortcut.

Payment references are real application references by default. Use
`createPayment()` for automatic preparation, an explicit `reference` for a
manually prepared record, or `syntheticReferences: true` only for fixture and
HTTP tests that do not claim financial proof.

The core does not reset your database, read arbitrary tables, or create
production routes. Your application owns test data, cleanup, signature
verification, idempotency, and payment fulfilment.

For the callback contract and signing details, see the
[programmatic API guide](../../docs/advanced/programmatic-api.mdx).
