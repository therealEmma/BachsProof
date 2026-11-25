# CLI onboarding for an existing backend

`@bachsproof/cli` is the lowest-friction way to run BachsProof against an existing
application. It sends test webhooks to the application over HTTP; it does not
install routes, import production services, or require a BachsProof controller in
the target repository.

If this is your first BachsProof integration, start with the
[beginner quickstart](./quickstart.md). This page contains the full CLI and
provider reference.

## Install and initialize

Run these commands from the backend repository you want to test:

```bash
pnpm add -D @bachsproof/cli@1.1.0
pnpm exec bachsproof init
```

This creates only:

- `bachsproof.config.mjs`, which points at the application's webhook URL and
  selects the provider adapter;
- `tests/bachsproof.test.mjs`, which lists every supported scenario;
- `tests/bachsproof.setup.mjs`, an opt-in `createPayment(context)` template for
  creating fresh application payments;
- `tests/bachsproof.verify.mjs`, a deliberately failing test-side verifier
  template. It must be connected to committed application state before it is
  imported and enabled.

Start the backend in its normal test configuration, then run:

```bash
BACHSPROOF_TARGET_URL=http://127.0.0.1:3000 \
BACHSPROOF_WEBHOOK_PATH=/webhooks/bachs \
pnpm exec bachsproof test
```

On PowerShell:

```powershell
$env:BACHSPROOF_TARGET_URL = "http://127.0.0.1:3000"
$env:BACHSPROOF_WEBHOOK_PATH = "/webhooks/bachs"
pnpm exec bachsproof test
```

The generated suite expects real application references by default. The
recommended setup is to implement `createPayment(context)` in the generated
`tests/bachsproof.setup.mjs`, uncomment its import and `createPayment` entry in
`bachsproof.config.mjs`, and run the suite. BachsProof calls it only for selected
scenarios that need a reference. `context` contains `scenario`, `amountMinor`,
`currency`, `paymentIndex`, and `paymentCount`; the callback must return a fresh
application payment or order reference. `concurrent-unique-payments` receives
one callback invocation per participant, with indexes starting at zero.

For manual preparation, put an explicit `reference` on each selected test and
put one reference per participant in the `references` array for
`concurrent-unique-payments`. BachsProof validates that selected scenarios do not
reuse a reference. New projects should use explicit test fields or
`createPayment` rather than positional environment-variable ordering.

For isolated fixture-only testing, explicitly set
`BACHSPROOF_USE_SYNTHETIC_REFERENCES=true`; synthetic references must not be used
to claim that a real application payment or committed financial state was
verified. No payment preparation callback is invoked in synthetic mode.

Example setup using an existing test-only application API:

```js
// tests/bachsproof.setup.mjs
export async function createPayment({ scenario, amountMinor, currency }) {
  const response = await fetch(`${process.env.BACHSPROOF_TEST_API}/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario, amountMinor, currency, testOnly: true })
  });
  if (!response.ok) throw new Error(`test payment creation failed: HTTP ${response.status}`);
  const payment = await response.json();
  if (typeof payment.reference !== "string" || payment.reference.length === 0) {
    throw new Error("test payment API did not return a reference");
  }
  return payment.reference;
}
```

The callback may instead call an application service or seed a repository-owned
test database. It must use an isolated test environment and must not start a
real financial transaction. BachsProof does not invent a provider payment-create
endpoint; the application owns this preparation contract.

The generated test is intentionally black-box. A passing delivery check means
the configured endpoint accepted the test requests. It does not prove that the
application committed the correct financial state and it is not deterministic
race-condition coverage.

See [`scenarios.md`](./scenarios.md) for the complete coverage matrix,
documented Bachs lifecycle behavior, expected rejection handling, and the
programmatic SDK example.

## Bachs signing and raw bodies

The built-in adapter is explicitly `mode: "mock"`. It serializes a documented-
shaped Bachs `collection.succeeded` envelope for local testing; it does not call
Bachs, create a checkout, or claim to be a sandbox delivery.

When the target verifies Bachs signatures, set the same test secret used by the
application:

```bash
BACHS_WEBHOOK_SECRET=the-test-only-secret pnpm exec bachsproof test
```

BachsProof signs the exact serialized request body and sends the documented V2
header. The target must perform signature verification against the raw request
bytes before JSON parsing. Do not use live credentials or point this workflow at
a production webhook.

## Financial verification without production changes

For a correctness assertion, add a test-side callback to
`bachsproof.config.mjs`. The callback can import the application's existing Prisma
client or query a dedicated test database. It is not loaded by the production
server:

```js
import { bachsAdapter } from "@bachsproof/cli";
import { tests } from "./tests/bachsproof.test.mjs";
import { createPayment } from "./tests/bachsproof.setup.mjs";
import { prisma } from "./test-support/prisma.mjs";

export default {
  provider: bachsAdapter({ mode: "mock" }),
  target: {
    baseUrl: process.env.BACHSPROOF_TARGET_URL ?? "http://127.0.0.1:3000",
    webhookPath: process.env.BACHSPROOF_WEBHOOK_PATH ?? "/webhooks/bachs"
  },
  tests,
  createPayment,
  requireFinancialVerification: true,
  verify: async (reference, context) => {
    const credits = await prisma.walletCredit.findMany({ where: { reference } });
    return {
      reference,
      creditCount: credits.length,
      creditedAmountMinor: credits.reduce((sum, credit) => sum + Number(credit.amountMinor), 0),
      currency: credits[0]?.currency ?? "NGN"
    };
  }
};
```

Import `createPayment` from `./tests/bachsproof.setup.mjs` in the config before
enabling it. Pairing preparation with `verify` gives each scenario a fresh
payment and an independent read of the resulting committed state. Repeated
suite executions therefore do not depend on stale credits, provided the
application's test API or seeding logic creates isolated records and the test
environment has a cleanup policy.

`context` contains the scenario identifier, expected eligible/credit outcome,
related provider event identifiers, and delivery results. The expected outcome
is diagnostic context only; BachsProof still requires the callback to observe
committed state. Use `pending: true` while an asynchronous worker is still
processing, and keep the verifier limited to test code.

The callback result is validated and checked against BachsProof's financial
invariants. Use a dedicated test reference or isolated test database because
the default CLI target does not reset or delete application data.

Polling remains configurable without adding an HTTP inspection route:

```js
financialVerification: {
  completionDeadlineMs: 10_000,
  pollIntervalMs: 25,
  negativeObservationWindowMs: 250
}
```

## Provider adapters

The CLI accepts any `ProviderAdapter` from `@bachsproof/core`. A custom adapter
must provide a provider name and mode, create an event, serialize the exact
wire body, describe the expected state, and may add provider headers:

```js
import { defineConfig } from "@bachsproof/cli";
import { myProviderAdapter } from "./test-support/my-provider-adapter.mjs";
import { tests } from "./tests/bachsproof.test.mjs";

export default defineConfig({
  provider: myProviderAdapter({ mode: "test", secret: process.env.TEST_WEBHOOK_SECRET }),
  target: { baseUrl: "http://127.0.0.1:3000", webhookPath: "/webhooks/provider" },
  tests,
  requireFinancialVerification: true
});
```

Provider-specific signing can be implemented by the adapter's `headers(event)`
function. The built-in `signing` setting is intentionally limited to the
documented Bachs V2 test signature; BachsProof does not invent a signing contract
for another provider.

## Optional deterministic checkpoint mode

Black-box mode does not coordinate application execution. If a developer owns a
test-only build of the target and wants a controlled duplicate-credit race, add
the checkpoint configuration and instrument the application at the
idempotency-read barrier using `@bachsproof/sdk`:

```js
checkpoint: {
  name: "after-idempotency-check",
  timeoutMs: 10_000
}
```

```ts
await checkpoint("after-idempotency-check", { key: payment.reference });
```

This is an opt-in white-box integration. It requires the target to cooperate in
an explicitly authorized test environment and does not imply deterministic OS,
network, or database scheduling. Without it, `bachsproof test` remains a useful
contract/idempotency delivery test but must not be described as a race proof.

## CI and troubleshooting

Use machine-readable output in CI:

```bash
pnpm exec bachsproof test --json
```

The CLI runs configured scenarios sequentially by default. Delivery waves
inside a scenario remain concurrent where the scenario requires them. A single
`bachsproof test` command runs all 15 generated scenarios; use
`bachsproof test --name "underpaid payment"` for one scenario. Preparation
failures are reported for that scenario and no webhook is sent for it.

Useful checks when onboarding a backend:

1. Confirm the target process is running and the webhook path is reachable.
2. Confirm the target reads raw request bytes before Bachs signature verification.
3. Use a test-only secret and inspect the target's structured webhook logs.
4. Add `verify` before treating a pass as a financial
   correctness result.
5. Use the checkpoint mode only after the ordinary black-box flow is passing.

The CLI package is archive-tested from a temporary independent repository in
`examples/cli-independent-repository.test.ts`; that test installs the package
as a consumer would and invokes the installed `bachsproof` entry point.
