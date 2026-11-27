# BachsProof scenario coverage

BachsProof sends local, Bachs-shaped webhook requests to an authorized test
endpoint. The Bachs adapter does not call Bachs, create a checkout, or move
money.

The runner checks HTTP delivery first. If you connect `verify(reference,
context)`, it also checks the payment and ledger state your application saved.
An HTTP-only pass is not proof that a database write was correct.

## Prepare payment references

The CLI uses real application references by default. The recommended setup is
to implement `createPayment()` once:

```js
// tests/bachsproof.setup.mjs
import { randomUUID } from "node:crypto";

export async function createPayment({ scenario, amountMinor, currency }) {
  const payment = await testDatabase.payment.create({
    data: {
      reference: `bachsproof-${scenario}-${randomUUID()}`,
      amountMinor,
      currency,
      status: "PENDING"
    }
  });
  return payment.reference;
}
```

`testDatabase` is your own isolated test database client. Each callback call
must create a fresh record and return the reference that your webhook handler
uses. For `concurrent-unique-payments`, BachsProof calls the callback once per
payment.

You can also put a prepared `reference` on a test, or one reference per
participant in `references`. Use synthetic references only for adapter or HTTP
fixture tests:

```powershell
$env:BACHSPROOF_USE_SYNTHETIC_REFERENCES = "true"
pnpm exec bachsproof test
```

Synthetic references do not prove that your application stored money.

## Coverage matrix

| Scenario | What it tests | Expected financial state |
| --- | --- | --- |
| `sequential-duplicate-webhook` | Same event twice in order | One eligible credit |
| `concurrent-duplicate-credit` | Same event at the same time | One eligible credit |
| `concurrent-unique-payments` | Separate payments together | One credit per reference |
| `cross-event-duplicate-payment` | Two event types for one payment | One eligible credit |
| `out-of-order-events` | Older event after newer success | One eligible credit; no regression |
| `delayed-payment-confirmation` | Valid success after an early signal | One eligible credit |
| `incomplete-checkout` | Checkout with no collected charge | Zero credits |
| `expired-checkout` | Checkout expiry | Zero credits |
| `tampered-webhook` | Body changed after signing | Reject and zero credits |
| `invalid-webhook-signature` | Bad signature | Reject and zero credits |
| `malformed-webhook` | Invalid JSON | Reject and zero credits |
| `incorrect-payment-amount` | Wrong amount for the stored order | Zero credits |
| `incorrect-payment-currency` | Wrong currency for the stored order | Zero credits |
| `underpaid-payment` | Payment shortfall | Zero credits |
| `failed-payment` | Failed collection | Zero credits |

## Run a scenario

```bash
pnpm exec bachsproof test --name "sequential duplicate webhook"
pnpm exec bachsproof test
```

The individual [scenario pages](scenarios/index.mdx) explain the test, why it
matters, the event BachsProof sends, the application behavior, and the exact
pass/failure result. For a complete setup, use the [quickstart](quickstart.md).

## HTTP and financial results are separate

Most eligible events normally expect a 2xx response. Security and parser tests
normally expect a 4xx response. You can set `expectedStatus` to match your
documented application contract.

For negative scenarios, a correct 4xx still does not prove that no credit was
written. Use `verify()` and expect zero credits. For asynchronous applications,
return `pending: true` while a worker can still change the saved state.

## Important limits

Normal concurrent delivery creates overlapping HTTP requests, but the operating
system may schedule them differently on each run. Use the optional checkpoint
SDK when you need two requests to pause at the same application line. A
checkpoint helps reproduce a race; it is not a database lock.

The adapter follows the documented Bachs event shapes used by these scenarios.
It does not simulate live provider settlement, network retries outside the
listed plan, or every possible provider event. Your application remains
responsible for signature verification, idempotency, transactions, and
reconciliation.
