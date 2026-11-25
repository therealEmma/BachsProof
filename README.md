# PayProof

PayProof is an SDK-first TypeScript framework for testing payment correctness at
the boundary where payment webhooks become application state.

It is designed to find bugs that ordinary unit tests and sequential integration
tests often miss:

- duplicate webhook deliveries creating duplicate wallet credits;
- check-then-insert races between overlapping requests;
- distinct payments interfering with one another;
- older lifecycle events replacing newer state;
- fulfillment for the wrong amount or currency;
- fulfillment for incomplete, expired, underpaid, or failed payments;
- signature verification over reconstructed rather than original request bytes;
- malformed webhook requests reaching unsafe business logic.

PayProof is an engineering test tool, not a payment processor, checkout client,
reconciliation service, or production-readiness guarantee. It does not move
money. Developers remain responsible for authorization, webhook security,
persistence, reconciliation, idempotency, and financial integrity.

> Use synthetic events and generated payment records only in an isolated,
> authorized test environment. Never point PayProof at production or use live
> payment credentials without explicit approval.

## Contents

- [What PayProof tests](#what-payproof-tests)
- [Proof levels](#proof-levels)
- [Requirements](#requirements)
- [Install and initialize an independent project](#install-and-initialize-an-independent-project)
- [Configure the generated project](#configure-the-generated-project)
- [Prepare test payments](#prepare-test-payments)
- [Verify committed financial state](#verify-committed-financial-state)
- [Run the CLI](#run-the-cli)
- [Scenario coverage](#scenario-coverage)
- [Programmatic SDK usage](#programmatic-sdk-usage)
- [Optional checkpoint testing](#optional-checkpoint-testing)
- [Bachs integration boundary](#bachs-integration-boundary)
- [Provider adapters](#provider-adapters)
- [Reports and failure interpretation](#reports-and-failure-interpretation)
- [Reference wallet demonstration](#reference-wallet-demonstration)
- [Repository development](#repository-development)
- [Architecture](#architecture)
- [Limitations and responsibility](#limitations-and-responsibility)
- [Documentation](#documentation)

## What PayProof tests

A webhook endpoint returning HTTP 200 does not prove that money was credited
correctly. A handler can acknowledge a request while it:

1. inserts two credits for one payment;
2. credits an order for the wrong amount or currency;
3. fulfills checkout.completed even though no payment was collected;
4. fulfills a retryable or underpaid collection;
5. lets an expired event overwrite a later successful payment;
6. accepts a body whose signature was calculated over different bytes; or
7. turns malformed input into an unsafe application error.

The classic duplicate-credit race looks like this:

    delivery A reads payment = PENDING
    delivery B reads payment = PENDING
    delivery A inserts credit and marks payment complete
    delivery B inserts another credit and marks payment complete

PayProof can send the duplicate requests together. An optional checkpoint can
pause both requests after the application's idempotency read so the vulnerable
interleaving is reproducible. Without instrumentation, PayProof still performs
a useful concurrent HTTP delivery test, but it does not claim deterministic
race-condition coverage.

## Proof levels

PayProof supports progressively stronger evidence without making the strongest
integration mandatory.

### Level 1: webhook delivery testing

Configure a provider, target URL, webhook path, and test definitions. PayProof
sends events and checks delivery outcomes.

result.passed means the configured delivery expectations were met. It does not
prove that a database row, wallet balance, or ledger entry was correct:
result.report.financiallyVerified is false.

This level is useful for routing, parser, signature, response, and error-path
checks.

### Level 2: committed financial verification

Configure verify(reference, context) in the test project. The callback reads the
application's committed payment, wallet, or ledger state and returns the
observed count and amount. PayProof applies its financial invariants to that
observed state.

This is the recommended mode for TypeScript applications because it can reuse
the application's existing test database client or repository without adding a
PayProof route to production code.

### Level 3: controlled checkpoint testing

Install @payproof/sdk in the test-only application build, enable its middleware
explicitly, and call checkpoint() at an application barrier. PayProof
coordinates the named barrier for the duplicate-credit scenario.

This is optional white-box instrumentation. It is not required by the CLI and
does not make arbitrary operating-system, network, or database scheduling
deterministic.

## Requirements

- Node.js 22 or later. The packages and official Bachs Node SDK target Node 22+.
- An isolated application environment with a reachable webhook endpoint.
- A test-only webhook signing secret when the application verifies signatures.
- A payment preparation strategy: createPayment, explicit references, or an
  explicit synthetic-fixture opt-in.
- A test-only financial verifier when committed state must be asserted.

PayProof itself does not require PostgreSQL, Prisma, Docker, or a particular
application framework. The reference wallet uses Prisma/PostgreSQL only to
demonstrate verification of committed records.

## Install and initialize an independent project

Run these commands from the repository containing the application under test.
PayProof does not need to be installed inside the PayProof monorepo.

Using pnpm:

    pnpm add -D @payproof/cli
    pnpm exec payproof init

Using npm:

    npm install --save-dev @payproof/cli
    npx payproof init

payproof init creates four files:

    payproof.config.mjs          # provider, target, signing, callbacks, tests
    tests/payproof.test.mjs      # all 15 generated scenarios
    tests/payproof.setup.mjs     # opt-in createPayment(context) template
    tests/payproof.verify.mjs    # deliberately failing verifier template

The setup and verifier files fail loudly until they are implemented. This is
intentional: PayProof must not silently invent an application reference or
return expected financial values and report a false pass.

Initialization refuses to overwrite an existing file. Use --force only when
replacing every generated file is intentional:

    pnpm exec payproof init --force

The CLI prints a beginner-friendly six-step guide after initialization.

## Configure the generated project

### Point PayProof at the test application

The generated configuration composes the target URL from baseUrl and
webhookPath:

    // payproof.config.mjs
    const target = {
      baseUrl: process.env.PAYPROOF_TARGET_URL ?? "http://127.0.0.1:3000",
      webhookPath: process.env.PAYPROOF_WEBHOOK_PATH ?? "/webhooks/bachs",
      // The application owns isolation; PayProof will not call a reset route.
      reset: false
    };

Together, those values address:

    http://127.0.0.1:3000/webhooks/bachs

For an application with a protected test-only reset route:

    const target = {
      baseUrl: "http://127.0.0.1:3000",
      webhookPath: "/webhooks/bachs",
      resetPath: "/__payproof/reset",
      reset: true,
      headers: {
        authorization: "Bearer " + process.env.PAYPROOF_TEST_TOKEN
      }
    };

Do not expose a destructive reset route in production. The safer default for an
existing backend is reset: false plus application-owned, scoped isolation.

### Configure signing

For the built-in Bachs adapter, set the same test-only webhook secret used by
the application:

    $env:PAYPROOF_TARGET_URL = "http://127.0.0.1:3000"
    $env:PAYPROOF_WEBHOOK_PATH = "/webhooks/bachs"
    $env:BACHS_WEBHOOK_SECRET = "test-only-secret"
    pnpm exec payproof test

The generated configuration turns that value into:

    const signingSecret = process.env.BACHS_WEBHOOK_SECRET;
    const signing = signingSecret
      ? { type: "bachs", secret: signingSecret }
      : undefined;

PayProof signs the exact serialized request body. The application must verify
the original raw bytes before JSON parsing with the provider's documented
verification behavior.

### Configure amount and currency

The generated test file uses:

    const amountMinor = Number(process.env.PAYPROOF_AMOUNT_MINOR ?? 5_000_000);
    const currency = process.env.PAYPROOF_CURRENCY ?? "NGN";

amountMinor is an integer in the smallest unit used by the test contract. For a
two-decimal currency:

- 500_000 represents 5,000.00 units;
- 5_000_000 represents 50,000.00 units.

The Bachs adapter serializes provider amounts as decimal strings and parses them
with exact arithmetic. Do not use JavaScript floating-point math for financial
comparisons in the application under test.

### Configure scenario definitions

The generated tests/payproof.test.mjs contains all 15 scenarios. Each entry
has a readable name, a core scenario, and amount/currency settings:

    export const tests = [
      {
        name: "sequential duplicate webhook",
        scenario: "sequential-duplicate-webhook",
        amountMinor,
        currency,
        syntheticReferences
      },
      {
        name: "underpaid payment",
        scenario: "underpaid-payment",
        amountMinor,
        currency,
        syntheticReferences,
        expectedStatus: "2xx"
      }
    ];

The CLI executes selected scenario definitions sequentially by default. Delivery
waves inside one scenario remain concurrent when that scenario requires overlap.
This keeps independent scenario data isolated while still testing concurrency
where it matters.

## Prepare test payments

Real application references are the default. A webhook should point to a
payment or order that exists in the target application's isolated test data.

PayProof supports three preparation modes.

### Recommended: createPayment(context)

Implement the generated callback once in tests/payproof.setup.mjs and
uncomment it in payproof.config.mjs:

    // tests/payproof.setup.mjs
    export async function createPayment({
      scenario,
      amountMinor,
      currency,
      paymentIndex,
      paymentCount
    }) {
      const response = await fetch(process.env.PAYPROOF_TEST_API + "/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scenario,
          amountMinor,
          currency,
          paymentIndex,
          paymentCount,
          testOnly: true
        })
      });

      if (!response.ok) {
        throw new Error("test payment creation failed: HTTP " + response.status);
      }

      const payment = await response.json();
      if (typeof payment.reference !== "string" || payment.reference.trim() === "") {
        throw new Error("test payment API did not return a reference");
      }
      return payment.reference;
    }

The callback may call an existing application service, repository, ORM, seed
helper, or test-only API. PayProof does not require a new production endpoint
and does not invent a Bachs payment-creation endpoint.

The callback receives:

| Field | Meaning |
| --- | --- |
| scenario | Selected PayProof scenario identifier |
| amountMinor | Requested integer amount in minor units |
| currency | Three-letter currency code |
| paymentIndex | Zero-based index for this scenario's payment |
| paymentCount | Total references required by this scenario |

For ordinary scenarios, paymentCount is 1. For concurrent-unique-payments,
PayProof invokes the callback once per payment; the default count is 2, or the
configured concurrency value.

Every callback invocation must create or identify a fresh, isolated application
payment and return a non-empty reference that the webhook handler understands.
PayProof validates returned references and prevents a selected suite from
reusing a reference across independent scenarios. If preparation fails, the
scenario fails and no webhook is delivered for that scenario.

Repeated suite runs invoke the callback again. The callback is responsible for
fresh records; the application is responsible for cleanup or retention policy.

Enable the callback:

    // payproof.config.mjs
    import { createPayment } from "./tests/payproof.setup.mjs";

    export default {
      provider,
      target,
      signing,
      createPayment,
      tests
    };

### Manual references

Manual references remain useful for a small number of tests or an existing
fixture:

    export const tests = [
      {
        name: "duplicate payment",
        scenario: "concurrent-duplicate-credit",
        reference: "test-order-001",
        amountMinor: 500_000,
        currency: "NGN"
      },
      {
        name: "two independent payments",
        scenario: "concurrent-unique-payments",
        references: ["test-order-002", "test-order-003"],
        concurrency: 2,
        amountMinor: 500_000,
        currency: "NGN"
      }
    ];

References must be non-empty. The unique-payments scenario requires at least
two distinct references, and its concurrency must match the number supplied.
Explicit references take precedence over createPayment.

Older configurations that translate positional PAYPROOF_REFERENCES values into
test definitions remain usable, but new projects should prefer explicit fields
or the callback. Positional environment-variable ordering is fragile and no
longer generated by payproof init.

### Synthetic references

Synthetic references are an explicit opt-in for fixture-only tests:

    $env:PAYPROOF_USE_SYNTHETIC_REFERENCES = "true"
    pnpm exec payproof test --name "sequential duplicate webhook"

Synthetic references let an adapter create a local event without an application
payment record. They are useful for adapter, parser, and HTTP contract tests,
but cannot establish that a real payment was found or that committed financial
state was correct. The preparation callback is not invoked in synthetic mode.

## Verify committed financial state

An HTTP response is not financial evidence. Implement the generated test-side
verifier:

    // tests/payproof.verify.mjs
    import { prisma } from "../test-support/prisma.mjs";

    export async function verify(reference, context) {
      const payment = await prisma.payment.findUnique({ where: { reference } });
      const credits = await prisma.walletCredit.findMany({ where: { reference } });

      return {
        reference,
        creditCount: credits.length,
        creditedAmountMinor: credits.reduce(
          (total, credit) => total + Number(credit.amountMinor),
          0
        ),
        currency: payment?.currency ?? context?.expectedOutcome.currency ?? "NGN",
        status: payment?.status ?? "PENDING",
        pending: !payment || payment.status === "PENDING",
        ledgerEntries: credits.map((credit) => ({
          id: String(credit.id),
          type: String(credit.type),
          amountMinor: Number(credit.amountMinor),
          currency: credit.currency
        }))
      };
    }

Adapt model names and amount conversion to the application. If the application
stores amounts as database BIGINT or decimal values, apply an application-
specific range check before converting to the integer shape accepted by PayProof.

The callback return contract is:

    type FinancialVerificationInput = {
      reference: string;
      creditCount: number;
      creditedAmountMinor: number;
      currency: string;
      status?: string;
      pending?: boolean;
      ledgerEntries?: Array<{
        id: string;
        type: string;
        amountMinor: number;
        currency?: string;
      }>;
    };

The second argument is optional for backward compatibility:

    verify(reference);             // existing integrations remain valid
    verify(reference, context);    // scenario-aware verification

The context includes:

    {
      scenario,
      paymentReference,
      expected,
      expectedOutcome: {
        eligible,
        expectedCreditCount,
        amountMinor,
        currency
      },
      events,
      eventIdentifiers,
      deliveries
    }

expectedOutcome explains the assertion PayProof will make; it is not proof of
the application's state. Never hardcode expected values just to pass. Read
committed records and let PayProof compare observation to expectation.

### Asynchronous processing

If the webhook queues work for a worker, return pending: true while committed
financial state is not ready. PayProof polls within a bounded deadline. The
legacy HTTP inspection configuration can tune polling:

    verification: {
      endpoint: "/internal/test/payment-state",
      headers: {
        authorization: "Bearer " + process.env.PAYPROOF_TEST_TOKEN
      },
      completionDeadlineMs: 10_000,
      pollIntervalMs: 25,
      negativeObservationWindowMs: 250
    }

The same timing options are used with callback verification when present. For
negative scenarios, PayProof observes the application for a bounded window so
an immediate zero does not hide a delayed erroneous credit. An expected zero
from configuration alone never proves that no credit was committed.

Enable financial verification:

    import { verify } from "./tests/payproof.verify.mjs";

    export default {
      provider,
      target,
      signing,
      verify,
      requireFinancialVerification: true,
      tests
    };

requireFinancialVerification: true makes the CLI fail if no verifier is
configured or if a run does not establish financial verification.

## Run the CLI

Start the application in its isolated test configuration, then run one scenario:

    pnpm exec payproof test --name "sequential duplicate webhook"

Run every generated scenario:

    pnpm exec payproof test

Available commands and options:

    payproof init [directory] [--force]
    payproof test [--config <path>] [--name <test-name>] [--json]

name uses the exact name property from the test file. Machine-readable output
is useful in CI:

    pnpm exec payproof test --json > payproof-results.json

Non-JSON output includes one line per scenario and a consolidated summary:

    Summary: 15/15 passed, 0 failed, 15 financially verified, 0 unverified,
    0 financial violations, 420ms

The summary distinguishes passed and failed scenarios, financially verified and
unverified scenarios, total financial invariant violations, and duration.

A delivery-only run may report PASS while warning that financial state was not
verified. Treat it as a webhook contract result, not a financial pass.

## Scenario coverage

All 15 scenarios are generated by payproof init and available through the CLI
and PayProof.run. The built-in Bachs adapter supplies the documented-shaped
fixtures below.

| Scenario | Delivery plan | Detects | Normal HTTP | Expected financial state |
| --- | --- | --- | --- | --- |
| sequential-duplicate-webhook | Same eligible collection.succeeded twice in sequence | Missing idempotency | 2xx | Exactly one credit |
| concurrent-duplicate-credit | Same eligible event in a concurrent wave | Check-then-insert races | 2xx | Exactly one credit |
| concurrent-unique-payments | Distinct eligible events in one wave | Cross-payment interference | 2xx | One credit per reference |
| cross-event-duplicate-payment | checkout.completed plus collection.succeeded for one payment | Credit once per event type | 2xx | Exactly one credit |
| out-of-order-events | Newer success followed by older expiry | State regression | 2xx | Success remains fulfilled |
| delayed-payment-confirmation | Expiry followed by delayed success | Permanent rejection after early state | 2xx | One credit after polling |
| incomplete-checkout | Completion without collected charge | Checkout-only fulfillment | Usually 2xx | Zero credits |
| expired-checkout | checkout.expired | Expiry treated as payment | Usually 2xx | Zero credits |
| tampered-webhook | Body changed after signing | Wrong raw-body verification | Normally 4xx | Zero credits |
| invalid-webhook-signature | Valid body with invalid signature | Missing or incorrect authentication | Normally 4xx | Zero credits |
| malformed-webhook | Malformed JSON | Unsafe parser/error path | Normally 4xx | Zero credits |
| incorrect-payment-amount | Success with mutated amount | Missing amount matching | Adapter contract | Zero credits |
| incorrect-payment-currency | Success with mutated currency | Missing currency matching | Adapter contract | Zero credits |
| underpaid-payment | Documented collection.underpaid | Fulfilling before shortfall paid | Usually 2xx | Zero credits |
| failed-payment | Documented collection.failed | Fulfilling failed/retryable collection | Usually 2xx | Zero credits |

Use expectedStatus when the application's documented contract intentionally
rejects a fixture:

    {
      name: "invalid signature",
      scenario: "invalid-webhook-signature",
      expectedStatus: [400, 401],
      reference: "test-invalid-signature-001"
    }

Supported forms are a status number, an array of status numbers, or 2xx, 4xx,
and 5xx. Expected HTTP behavior is evaluated separately from financial
correctness: a request can return the expected 400 and still fail because it
created a credit.

Important scenario boundaries:

- concurrent-duplicate-credit uses one reference. Without a checkpoint it sends
  the configured number of identical webhooks using Promise.allSettled and
  preserves every delivery error. With a checkpoint, the named barrier is
  coordinated.
- concurrent-unique-payments requires independent references. With createPayment,
  PayProof prepares one reference per participant and verifies each independently.
- cross-event-duplicate-payment models distinct lifecycle event IDs that identify
  one underlying checkout/charge. It is not a rule that every event type is
  always a duplicate.
- out-of-order-events and delayed-payment-confirmation test lifecycle ordering.
  The target must preserve a later valid payment.
- Negative financial scenarios must not create a credit even when their webhook
  response is an acknowledgment.
- Amount/currency mutation scenarios are synthetic adapter mutations, not claims
  about live provider-side mutations.

See docs/scenarios.md for the full matrix, event references, and guides.

## Programmatic SDK usage

Install the provider-neutral engine and Bachs adapter:

    pnpm add -D @payproof/core @payproof/bachs

The smallest real-reference run is:

    import { PayProof } from "@payproof/core";
    import { bachsAdapter } from "@payproof/bachs";

    const payproof = new PayProof({
      provider: bachsAdapter({ mode: "mock" }),
      target: {
        baseUrl: "http://127.0.0.1:3000",
        webhookPath: "/webhooks/bachs",
        reset: false
      }
    });

    const result = await payproof.run({
      scenario: "concurrent-duplicate-credit",
      reference: "isolated-test-order-001",
      amountMinor: 500_000,
      currency: "NGN",
      concurrency: 2
    });

    if (!result.passed) console.error(result.report);

The supplied reference must exist in the application unless
syntheticReferences: true is explicitly selected.

### Programmatic preparation and verification

    const payproof = new PayProof({
      provider: bachsAdapter({ mode: "mock" }),
      target: {
        baseUrl: "http://127.0.0.1:3000",
        webhookPath: "/webhooks/bachs",
        reset: false
      },
      createPayment: async ({ scenario, amountMinor, currency, paymentIndex }) => {
        return testSupport.createIsolatedPayment({
          scenario,
          amountMinor,
          currency,
          paymentIndex
        });
      },
      verify: async (reference, context) => {
        const observed = await testSupport.readCommittedFinancialState(reference);
        return {
          reference,
          creditCount: observed.credits.length,
          creditedAmountMinor: observed.credits.reduce(
            (total, credit) => total + credit.amountMinor,
            0
          ),
          currency: observed.currency,
          status: observed.status,
          pending: observed.pending,
          ledgerEntries: observed.credits.map((credit) => ({
            id: credit.id,
            type: credit.type,
            amountMinor: credit.amountMinor,
            currency: credit.currency
          }))
        };
      }
    });

    const result = await payproof.run({
      scenario: "cross-event-duplicate-payment",
      amountMinor: 500_000,
      currency: "NGN"
    });

The callback is used only when no explicit reference or synthetic mode was
supplied. For multiple payments, pass explicit references or let createPayment
prepare one per participant:

    const result = await payproof.run({
      scenario: "concurrent-unique-payments",
      references: ["isolated-order-002", "isolated-order-003"],
      concurrency: 2,
      amountMinor: 500_000,
      currency: "NGN"
    });

### Programmatic signing

The CLI adds Bachs signing configuration. Programmatic callers can wrap the
adapter and sign the exact body passed to the transport:

    import { bachsAdapter, signBachsWebhook } from "@payproof/bachs";

    const baseProvider = bachsAdapter({ mode: "mock" });
    const provider = {
      ...baseProvider,
      headersForBody(event, body) {
        return {
          ...(baseProvider.headers?.(event) ?? {}),
          ...signBachsWebhook(body, process.env.BACHS_WEBHOOK_SECRET ?? "test-only-secret")
        };
      }
    };

Use a test-only secret and keep raw-body verification aligned with the official
Bachs SDK. This remains local mock mode; it does not call Bachs or create a
sandbox checkout.

### Replays

Reports include a replay seed, delivery records, event identifiers, and
checkpoint trace. A caller can replay a report:

    const replayed = await payproof.replay(result.report);

Replay reuses the recorded event and schedule metadata. It does not make
un-instrumented network, operating-system, or database scheduling deterministic.

## Optional checkpoint testing

Install the test-only SDK in the application under test:

    pnpm add -D @payproof/sdk

Configure the CLI or programmatic runner:

    checkpoint: {
      name: "after-idempotency-check",
      timeoutMs: 10_000
    }

In an explicitly enabled test build, install middleware and place the barrier
after the idempotency read and before the financial write:

    import {
      checkpoint,
      checkpointMiddleware,
      configureCheckpoint
    } from "@payproof/sdk";

    configureCheckpoint({
      allowRequestHeaders: process.env.PAYPROOF_TEST_MODE === "true"
    });
    app.use(checkpointMiddleware({
      enabled: process.env.PAYPROOF_TEST_MODE === "true"
    }));

    // Inside the webhook handler:
    await checkpoint("after-idempotency-check", {
      key: payment.reference
    });

The SDK is dependency-light and does nothing when disabled. Request-header
activation requires explicit application configuration; PayProof cannot turn on
instrumentation in an arbitrary production process.

Checkpoint mode is used for the duplicate-credit race. The report marks
replay.controlled true only when that named checkpoint is active. Without a
checkpoint, duplicate deliveries still run concurrently, but
replay.controlled is false.

See docs/replay.md, docs/race-controller.md, and packages/sdk/README.md.

## Bachs integration boundary

PayProof's Bachs package is explicit about what it does and does not prove.

### What @payproof/bachs provides

- bachsAdapter({ mode: "mock" }) for deterministic local fixtures;
- documented-shaped webhook envelopes for five payment lifecycle events;
- exact decimal-string money parsing and minor-unit normalization;
- local Bachs signing helpers for test requests;
- provider scenario plans used by the reusable core runner.

### What it does not provide

- no Bachs API calls;
- no checkout-session creation;
- no live or sandbox payment;
- no settlement, provider retry, or dashboard delivery proof;
- no live webhook forwarding;
- no claim that a synthetic event is an authentic provider delivery.

The supported event contracts are:

| Event | Correctness meaning used by PayProof |
| --- | --- |
| checkout.completed | Checkout finished; inspect payment_status and charge before fulfilling. no_payment_required is not a collected payment. |
| collection.succeeded | A payment was collected. Match reference, amount, currency, and payment identity before crediting. |
| checkout.expired | An open checkout expired without payment. It must not create a credit; a later payment may still complete the checkout. |
| collection.underpaid | The documented received amount is below the amount due. Do not fulfill until an eligible success is observed. |
| collection.failed | A payment attempt failed and the checkout can remain open. Do not credit it. |

The official Bachs envelope contains id, type, created_at, organization_id, and
data. Use event id for delivery deduplication and do not reject unknown fields;
providers may add fields compatibly.

Bachs money values are decimal strings, not JavaScript numbers. PayProof keeps
provider money parsing separate from the provider-neutral core so exact
arithmetic is applied before invariants compare amounts.

### Raw-body signature verification

The target application must:

1. read the original request bytes;
2. verify the documented Bachs signature and timestamp using the test secret;
3. only then parse and process JSON;
4. return a rejection status for invalid authentication;
5. return 5xx when its own processing fails and retry is appropriate.

For Node.js applications, use the official SDK's
webhooks.constructEvent(rawBody, request.headers, secret) helper. The Bachs
documentation describes X-Bachs-Signature-V2, raw-body HMAC input, timestamp
tolerance, and secret rotation behavior.

Official references:

- [Bachs webhook setup and signature verification](https://docs.bachs.io/guides/webhooks/overview)
- [checkout.completed](https://docs.bachs.io/guides/webhooks/events/checkout-completed)
- [checkout.expired](https://docs.bachs.io/guides/webhooks/events/checkout-expired)
- [collection.succeeded](https://docs.bachs.io/guides/webhooks/events/collection-succeeded)
- [collection.underpaid](https://docs.bachs.io/guides/webhooks/events/collection-underpaid)
- [collection.failed](https://docs.bachs.io/guides/webhooks/events/collection-failed)
- [Official Bachs Node.js SDK](https://docs.bachs.io/sdks/node)
- [Official Bachs Node SDK source](https://github.com/bachsdev/bachs-node)

## Provider adapters

The core is provider-neutral. An adapter owns provider-specific event creation,
serialization, expected state, headers, signing, and lifecycle plans.

The public contract includes:

    interface ProviderAdapter<TEvent extends PaymentEvent> {
      readonly name: string;
      readonly mode: string;
      createPayment(input?: {
        reference?: string;
        amountMinor?: number;
        currency?: string;
        eligible?: boolean;
        customerId?: string;
        syntheticReferences?: boolean;
      }): TEvent;
      serialize(event: TEvent): string;
      expectedState(event: TEvent): ExpectedPaymentState;
      headers?(event: TEvent): Record<string, string>;
      headersForBody?(event: TEvent, body: string | Uint8Array): Record<string, string>;
      createScenario?(scenario: ScenarioName, input: RunOptions): ProviderScenario<TEvent> | undefined;
    }

A custom adapter must implement a real, documented provider contract. PayProof
does not infer event types, payload fields, signature formats, endpoints, or
retry behavior for another provider. If an adapter cannot justify a scenario's
event semantics, that scenario should remain unsupported for that adapter.

The Bachs-only signing configuration is intentionally not a generic signing
contract. Provider-specific adapters should sign the exact serialized body in
headersForBody when required.

## Reports and failure interpretation

Every run returns a PayProofResult with passed and a structured report. The
report includes scenario, provider, adapter mode, primary event, expected state,
observed state, verification mode, financiallyVerified, per-payment
observations, delivery records, checkpoint traces, errors, replay metadata, and
timestamps.

deliveries retains a record for every attempted request, including participant,
reference, event ID/type, status, response body, expected status, timing, and
error. Concurrent failures are collected with Promise.allSettled rather than
lost after the first rejection.

Financial invariants are applied to independently observed state:

| ID | Invariant |
| --- | --- |
| INV-001 | At most one credit exists for one financial payment. |
| INV-002 | A posted credit has the expected amount and currency. |
| INV-003 | An eligible payment reaches its expected credit count. |
| INV-004 | An ineligible payment creates no credit. |
| INV-005 | An eligible payment's aggregate credited amount matches the expected amount. |

For concurrent unique payments, each reference is inspected independently. This
prevents one over-credit and one under-credit from cancelling out in an
aggregate-only balance check.

Common results:

| Output | Meaning |
| --- | --- |
| PASS, financially verified | Deliveries matched expectations and committed state satisfied the invariants. |
| PASS, unverified | Delivery behavior passed, but committed state was not inspected. This is not a financial pass. |
| FAIL, no deliveries | Configuration, reference preparation, reset, or adapter validation failed before HTTP delivery. |
| FAIL, HTTP delivery error | The target was unreachable, returned an unexpected status, or rejected an unconfigured response. |
| FAIL, financial violation | Observed committed state violated one or more invariants. |
| FAIL, verification timeout | Asynchronous processing did not expose complete state within the deadline. |

The CLI adds actionable hints for missing references, reused references, failed
preparation, missing financial verification, unreachable URLs, unexpected
statuses, and reset failures.

## Reference wallet demonstration

apps/reference-wallet is an Express 5 + Prisma/PostgreSQL demonstration with:

- deliberately vulnerable and corrected webhook handlers;
- Bachs raw-body signature verification through the official Node SDK;
- in-memory and PostgreSQL stores;
- test-only reset and state endpoints protected by test configuration;
- committed credit and ledger records for financial verification.

The vulnerable mode is intentionally retained so the demonstration proves that a
real persisted implementation can fail the duplicate-credit invariant.

### Fast in-memory demonstration

From the PayProof repository:

    pnpm install
    pnpm build
    pnpm exec vitest run apps/reference-wallet/tests/wallet.integration.test.ts

The corrected handler should produce one committed credit under the controlled
duplicate schedule. The vulnerable handler should produce duplicate committed
credits and fail the invariant.

### PostgreSQL demonstration

PostgreSQL is optional for the rest of the repository. When DATABASE_URL is
available, use a dedicated test database:

    Copy-Item .env.example .env
    # Set DATABASE_URL to an isolated Railway or test PostgreSQL URL.
    pnpm --filter @payproof/reference-wallet db:generate
    pnpm --filter @payproof/reference-wallet db:migrate:deploy
    $env:PAYPROOF_TEST_MODE = "true"
    $env:PAYPROOF_WALLET_MODE = "corrected"
    pnpm --filter @payproof/reference-wallet start

Run the explicit PostgreSQL test in another terminal:

    pnpm test:postgres

Do not claim PostgreSQL integration passed if the test was skipped because the
database URL was not supplied or reachable. The suite uses scoped references and
cleanup. Never aim it at a production database.

### Why the corrected handler works

The demonstration keeps two identities separate:

- the webhook event ID deduplicates one provider delivery;
- a payment-reference-derived credit idempotency key prevents distinct lifecycle
  events for one financial payment from creating two credits.

The corrected path rechecks payment and performs event, credit, balance, and
completion updates in one database transaction. The checkpoint is outside that
transaction, so a test barrier does not hold a database transaction open.

See docs/engineering-demo.md for the vulnerable sequence, corrected transaction,
database evidence, and limitations.

## Repository development

This repository is a pnpm workspace containing packages, the reference
application, examples, and regression tests.

Install and build:

    pnpm install
    pnpm build

Run the fast suite:

    pnpm test

Run TypeScript checks:

    pnpm typecheck

Run PostgreSQL tests only when DATABASE_URL is configured and reachable:

    pnpm test:postgres

Generate local npm archives without publishing:

    pnpm pack:check

pack:check rebuilds packages and writes local archives to reports/. It does not
publish anything.

The independent CLI regression test is:

    pnpm exec vitest run examples/cli-independent-repository.test.ts

It creates a temporary consumer-style project, installs the packaged CLI and
its package archives, runs the installed payproof init and payproof test
commands, executes the generated suite and an individual scenario, and checks
repeated-run reference isolation.

The archive-backed standalone callback example is in
examples/standalone-callback/README.md.

## Architecture

The main flow is:

    payproof init
      -> independent project configuration
      -> payproof test
      -> @payproof/core runner
      -> application payment preparation
      -> provider adapter and exact serialized body
      -> existing application webhook
      -> application-owned financial state
      -> callback or HTTP verification
      -> financial invariants
      -> scenario report and summary

Optional checkpoint flow:

    @payproof/sdk middleware
      -> request-scoped checkpoint context
      -> named application barrier
      -> @payproof/core race controller

Package responsibilities:

| Package or app | Responsibility |
| --- | --- |
| @payproof/core | Provider-neutral runner, payment preparation, concurrent delivery, polling, invariants, reports, replay, and optional race controller. |
| @payproof/bachs | Bachs-shaped local fixtures, exact money parsing, scenario plans, and test signing helper. |
| @payproof/cli | Package-installable payproof init and payproof test, config loading, generated boilerplate, summaries, and onboarding errors. |
| @payproof/sdk | Test-only request-scoped checkpoint middleware and barrier client. Disabled calls are no-ops. |
| apps/reference-wallet | Express/Prisma demonstration of vulnerable and corrected persistence. |
| examples/cli-independent-repository.test.ts | Consumer-style installation and CLI regression coverage outside the workspace runtime. |

The application remains responsible for its own routes, authentication,
transactions, event persistence, ledger semantics, and cleanup. PayProof only
orchestrates test requests and inspects state through the configured test
integration.

## Limitations and responsibility

PayProof deliberately does not claim more than its configured evidence supports:

- Black-box HTTP concurrency is not deterministic race-condition coverage.
- Checkpoints control named instrumented barriers only; they do not control all
  scheduler, network, database, worker, or provider timing.
- A synthetic Bachs-shaped webhook is not a real Bachs sandbox delivery.
- This repository does not create live checkouts, call live Bachs APIs, exercise
  provider settlement, or verify real provider retry delivery.
- Financial verification is only as trustworthy as the callback or protected
  inspection endpoint. Hardcoded expected values are not independent evidence.
- A passing run covers only the references, event shapes, target build, timing,
  database, and policies exercised by that run.
- The application must maintain its own isolation and cleanup policy.
- Provider scenarios are valid only when their adapter has a documented event
  contract.

Developers remain responsible for signature verification, payment identity,
amount/currency matching, durable idempotency, out-of-order and retryable event
handling, appropriate HTTP responses, test-route protection, and reconciliation.

## Documentation

- [Beginner quickstart](docs/quickstart.md)
- [CLI onboarding and provider reference](docs/cli.md)
- [Scenario coverage matrix](docs/scenarios.md)
- [Bachs integration boundary](docs/bachs-integration.md)
- [Architecture](docs/architecture.md)
- [Financial invariants](docs/financial-invariants.md)
- [Race controller](docs/race-controller.md)
- [Replay behavior](docs/replay.md)
- [Railway/PostgreSQL setup](docs/railway-postgres.md)
- [Engineering demonstration](docs/engineering-demo.md)
- [@payproof/core](packages/core/README.md)
- [@payproof/bachs](packages/bachs/README.md)
- [@payproof/sdk](packages/sdk/README.md)
- [@payproof/cli](packages/cli/README.md)

PayProof helps developers discover and explain payment correctness failures. It
is not a substitute for sound application design, provider documentation,
security review, reconciliation, or production operational controls.

