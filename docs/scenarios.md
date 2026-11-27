# BachsProof scenario coverage

BachsProof delivers synthetic, documented-shaped webhook requests to an
authorized test endpoint. The Bachs adapter does not call Bachs, create a
checkout, or create a real payment. Use it only with isolated test data.

The runner is black-box by default: it sends HTTP requests and treats an
optional `verify(reference, context)` callback as the source of committed
financial evidence. A delivery-only pass does not prove a database write,
wallet balance, or race-condition outcome.

## Prepare payment references

The generated CLI suite uses real application references by default. The
recommended workflow is to implement the generated `createPayment(context)`
callback once. BachsProof invokes it only for selected scenarios that need a
reference and passes the scenario, amount in minor units, currency, zero-based
payment index, and payment count. It invokes the callback twice for
`concurrent-unique-payments`, so the concurrent payments are independent.

```js
// tests/bachsproof.setup.mjs
export async function createPayment({ scenario, amountMinor, currency, paymentIndex, paymentCount }) {
  // Call an existing isolated test API, application service, or seed helper.
  const payment = await applicationTestApi.createPayment({ scenario, amountMinor, currency, paymentIndex, paymentCount });
  if (!payment?.reference) throw new Error("test payment preparation returned no reference");
  return payment.reference;
}
```

Uncomment the generated import and `createPayment` property in
`bachsproof.config.mjs`. BachsProof validates every returned reference before
delivery, rejects empty or reused references, and does not send a webhook when
preparation fails. Repeated suite runs call the callback again; the callback is
responsible for creating fresh isolated records.

Manual preparation remains supported: put a `reference` on each selected test
definition and put one reference per participant in `references` for
`concurrent-unique-payments`. Explicit references take precedence over the
callback. BachsProof does not infer payment identity from positional environment-variable
ordering; use explicit references or `createPayment` instead.

For a local adapter or fixture-only demonstration, opt in explicitly:

```powershell
$env:BACHSPROOF_USE_SYNTHETIC_REFERENCES = "true"
pnpm exec bachsproof test
```

Synthetic references create documented-shaped local webhook envelopes. They do
not represent a Bachs checkout, settlement, provider retry, or a committed
payment in the target application. The payment preparation callback is not
called in synthetic mode. Never use synthetic runs as evidence of production
financial correctness.

All rows in this matrix are implemented by the `@bachsproof/bachs` mock adapter.
Other providers can use the same core scenario names only when their adapter
supplies a documented `createScenario` plan; BachsProof does not infer or invent
another provider’s event contract.

## Coverage matrix

| Scenario | Bachs event(s) | Detects | Expected delivery | Expected financial state | CLI / SDK | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `sequential-duplicate-webhook` | Same `collection.succeeded` twice | Ordinary event-id/idempotency mistakes | 2xx | One eligible credit | Yes / Yes | Implemented |
| `concurrent-duplicate-credit` | Same `collection.succeeded` concurrently | Check-then-insert races | 2xx | One eligible credit | Yes / Yes | Implemented; checkpoint optional |
| `concurrent-unique-payments` | Distinct `collection.succeeded` events | Accidental cross-payment interference | 2xx | One credit per supplied reference | Yes / Yes | Implemented |
| `cross-event-duplicate-payment` | Paid `checkout.completed` plus `collection.succeeded` sharing checkout/charge | Treating two lifecycle events as two payments | 2xx | One eligible credit | Yes / Yes | Implemented |
| `out-of-order-events` | Newer success followed by older `checkout.expired` | Regressing state from late events | 2xx | One eligible credit | Yes / Yes | Implemented |
| `delayed-payment-confirmation` | `checkout.expired` followed by delayed success | Rejecting a later valid payment after expiry | 2xx | One eligible credit | Yes / Yes | Implemented |
| `incomplete-checkout` | `checkout.completed` with documented `no_payment_required` and no charge | Crediting a checkout without a collected charge | 2xx | Zero credits | Yes / Yes | Implemented |
| `expired-checkout` | `checkout.expired` | Crediting expiry or treating it as a successful payment | 2xx | Zero credits | Yes / Yes | Implemented |
| `tampered-webhook` | Valid event body changed after signing | Verifying a different body than the parsed body | Configurable, default any 4xx | Zero credits | Yes / Yes | Implemented |
| `invalid-webhook-signature` | Valid body with invalid Bachs signature | Missing or incorrect signature verification | Configurable, default any 4xx | Zero credits | Yes / Yes | Implemented |
| `malformed-webhook` | Malformed JSON body | Parser/error-path handling | Configurable, default any 4xx | Zero credits | Yes / Yes | Implemented |
| `incorrect-payment-amount` | Valid-shaped success with mutated amount | Fulfilling the wrong order amount | 2xx acknowledgment | Zero credits | Yes / Yes | Implemented synthetic mutation |
| `incorrect-payment-currency` | Valid-shaped success with mutated currency | Fulfilling the wrong currency | 2xx acknowledgment | Zero credits | Yes / Yes | Implemented synthetic mutation |
| `underpaid-payment` | `collection.underpaid` | Fulfilling before the shortfall is paid | 2xx | Zero credits | Yes / Yes | Implemented |
| `failed-payment` | `collection.failed` | Crediting a failed, retryable collection | 2xx | Zero credits | Yes / Yes | Implemented |

The `2xx` outcomes above are the normal webhook acknowledgment expectation.
Rejected scenarios accept an explicit `expectedStatus` such as `400`, `[400,
401]`, or `"4xx"` so an application’s documented test contract can be used
without treating an expected rejection as a runner failure.

## Individual scenario guide

Each scenario is independently executable with `bachsproof test --name` or
`BachsProof.run`. Use a fresh test reference for each row unless the purpose of
the scenario is to deliver more than one event for the same payment.

- `sequential-duplicate-webhook`: sends the same eligible event twice in
  sequence. It catches missing event-id or payment-reference idempotency and
  expects exactly one committed credit.
- `concurrent-duplicate-credit`: sends the same eligible event in a concurrent
  wave. It catches check-then-insert races. It needs one real reference and
  expects exactly one credit. A configured checkpoint makes the interleaving
  controlled; black-box mode remains timing-based.
- `concurrent-unique-payments`: sends distinct eligible events concurrently.
  Supply one reference per participant through `references`; it expects one
  credit for each reference and checks them independently.
- `cross-event-duplicate-payment`: sends paid `checkout.completed` and
  `collection.succeeded` events that identify the same financial payment. It
  catches event-type-based double fulfillment and expects one credit.
- `out-of-order-events`: sends a newer successful collection followed by an
  older expiry. It catches state regression and expects the successful payment
  to remain fulfilled.
- `delayed-payment-confirmation`: sends an incomplete/expired signal and then
  a delayed eligible success. It catches handlers that permanently reject a
  payment after an early lifecycle event and expects one credit after polling.
- `incomplete-checkout`: sends `checkout.completed` without a paid status and
  without a charge. It catches fulfillment based only on checkout completion
  and expects zero credits.
- `expired-checkout`: sends `checkout.expired`. It catches treating expiry as
  payment success and expects zero credits.
- `tampered-webhook`: changes the serialized body after signing. It catches
  signature verification over parsed or reconstructed data. Configure the
  target's documented rejection status; the default expectation is 4xx and
  zero credits.
- `invalid-webhook-signature`: sends a valid-shaped body with an invalid
  signature. It catches missing or incorrect authentication and expects the
  configured rejection status and zero credits.
- `malformed-webhook`: sends malformed JSON. It catches unsafe parser/error
  handling and expects the configured rejection status and zero credits.
- `incorrect-payment-amount`: sends a valid-shaped collection with a mutated
  amount for the reference. It catches fulfillment without order-amount
  matching and expects zero credits.
- `incorrect-payment-currency`: sends a valid-shaped collection with a
  different currency. It catches currency-blind fulfillment and expects zero
  credits.
- `underpaid-payment`: sends documented `collection.underpaid` fields for
  paid, expected, and remaining amounts. It catches fulfillment before the
  shortfall is collected and expects zero credits.
- `failed-payment`: sends documented `collection.failed` data. It catches
  fulfillment of a failed/retryable collection and expects zero credits.

For negative scenarios, an HTTP acknowledgment is independent of the financial
assertion. Configure a verifier and allow the application enough bounded time
to expose committed state; returning an expected zero from configuration alone
never proves that no credit was written.

## Verified Bachs contract used by the adapter

The fixtures follow the documented Bachs webhook envelope and event semantics:

- `checkout.completed` may be completed without a collected charge;
  fulfillment requires the paid status and a charge.
- `collection.succeeded` is the payment-collected event and uses decimal-string
  monetary fields.
- `checkout.expired` is not necessarily final; a later payment may complete.
- `collection.underpaid` carries `amount_paid`, `amount_expected`, and
  `amount_remaining` and must not fulfill the order.
- `collection.failed` is retryable while the checkout remains open and must not
  fulfill the order.
- Event IDs are delivery identities, event order is not guaranteed, and raw
  bodies must be verified with the documented Bachs signature scheme.

References: [Bachs webhook overview](https://docs.bachs.io/guides/webhooks/overview),
[checkout.completed](https://docs.bachs.io/guides/webhooks/events/checkout-completed),
[collection.succeeded](https://docs.bachs.io/guides/webhooks/events/collection-succeeded),
[checkout.expired](https://docs.bachs.io/guides/webhooks/events/checkout-expired),
[collection.underpaid](https://docs.bachs.io/guides/webhooks/events/collection-underpaid),
[collection.failed](https://docs.bachs.io/guides/webhooks/events/collection-failed),
and the [official Node SDK](https://docs.bachs.io/sdks/node).

## CLI

```powershell
pnpm add -D @bachsproof/cli
pnpm exec bachsproof init
$env:BACHSPROOF_TARGET_URL = "http://127.0.0.1:3000"
$env:BACHSPROOF_WEBHOOK_PATH = "/webhooks/bachs"
$env:BACHS_WEBHOOK_SECRET = "test-only-secret"
pnpm exec bachsproof test
pnpm exec bachsproof test --name "underpaid payment"
```

`bachsproof init` creates a commented configuration and a test file containing
every supported scenario. Edit the generated values for the target endpoint,
secret, references, amount, and currency. Add a test-only financial verifier
when committed database state must be checked.

## Programmatic SDK

```ts
import { BachsProof } from "@bachsproof/core";
import { bachsAdapter, signBachsWebhook } from "@bachsproof/bachs";

const base = bachsAdapter({ mode: "mock" });
const provider = {
  ...base,
  headersForBody(event, body) {
    return {
      ...(base.headers?.(event) ?? {}),
      ...signBachsWebhook(body, process.env.BACHS_WEBHOOK_SECRET ?? "test-only-secret")
    };
  }
};

const result = await new BachsProof({
  provider,
  target: { baseUrl: "http://127.0.0.1:3000", webhookPath: "/webhooks/bachs" },
  verify: async (reference, context) => readCommittedPaymentState(reference, context)
}).run({
  scenario: "cross-event-duplicate-payment",
  reference: "BACHSPROOF-CROSS-EVENT-001",
  amountMinor: 500_000,
  currency: "NGN"
});
```

`checkpoint` remains an optional `BachsProof` option for applications that
choose to expose the BachsProof controller protocol through test-only
instrumentation. Without it, duplicate deliveries still run concurrently via
`Promise.allSettled`, but the result must not be described as deterministic
database race coverage.

BachsProof assists developers with testing under the supplied conditions. It
does not guarantee production readiness or financial correctness outside those
conditions. Developers remain responsible for authorization, webhook security,
idempotency, transaction design, reconciliation, and financial integrity.
