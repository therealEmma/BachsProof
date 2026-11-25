# BachsProof beginner quickstart

This guide shows how to run BachsProof against an existing Express or TypeScript
payment application. BachsProof sends test webhooks to your application. It does
not add routes, change production code, call Bachs, or move real money.

Use an isolated test application and test database throughout this guide.

## 1. Install and initialize

From the application repository:

```bash
pnpm add -D @bachsproof/cli@1.1.0
pnpm exec bachsproof init
```

The command creates four files:

- `bachsproof.config.mjs` tells BachsProof where the webhook is and which helpers to use.
- `tests/bachsproof.test.mjs` lists the payment situations to test.
- `tests/bachsproof.setup.mjs` creates fresh test payment records.
- `tests/bachsproof.verify.mjs` reads the financial records your application committed.

The last two files are test-only helpers. Your production server does not import them.

## 2. Configure the webhook

Start your application in its test configuration. If it runs at
`http://127.0.0.1:3000` and its Bachs route is `/webhooks/bachs`, the complete
webhook URL is `http://127.0.0.1:3000/webhooks/bachs`.

On PowerShell:

```powershell
$env:BACHSPROOF_TARGET_URL = "http://127.0.0.1:3000"
$env:BACHSPROOF_WEBHOOK_PATH = "/webhooks/bachs"
$env:BACHS_WEBHOOK_SECRET = "your-test-only-secret"
```

The secret is needed only when your application verifies signatures. Use the same
test-only secret on both sides. Never use a production secret.

## 3. Prepare a test payment

Open `tests/bachsproof.setup.mjs`. A webhook normally contains a payment or order
reference, so the application needs a matching test record before the webhook arrives.

Replace the intentional error with your existing payment creation logic. You can use
an ORM, repository function, database seed helper, or internal test API. You do not
need to build a new API for BachsProof.

Here is a realistic Prisma-style example. Change the import and field names to match
your application:

```js
import { randomUUID } from "node:crypto";
import { prisma } from "../src/db.mjs";

export async function createPayment({ scenario, amountMinor, currency, paymentIndex }) {
  const reference = `bachsproof-${scenario}-${paymentIndex}-${randomUUID()}`;
  const payment = await prisma.payment.create({
    data: { reference, amountMinor, currency, status: "PENDING" }
  });
  return payment.reference;
}
```

The returned value must be a fresh reference that your webhook handler understands.
It might be an order ID, payment reference, or application idempotency key. BachsProof
calls this helper for every applicable scenario and once per payment when needed.

`amountMinor: 500000` means ₦5,000 when the currency has two decimal places.
`currency: "NGN"` means Nigerian naira. `scenario` tells you which test is running.
`paymentIndex` starts at zero, and `paymentCount` tells you how many payments are needed.

This creates a test record; it must not start a live card charge or other real
financial transaction.

## 4. Verify actual financial records

Open `tests/bachsproof.verify.mjs`. HTTP 200 only means that the route accepted a
webhook. It does not prove that the customer was credited once, for the correct
amount, or at all.

Read the payment and the records that represent actual money movement. For a wallet
application, those records might be wallet credits or ledger entries:

```js
import { prisma } from "../src/db.mjs";

export async function verify(reference, context) {
  const payment = await prisma.payment.findUnique({ where: { reference } });
  const credits = await prisma.walletCredit.findMany({ where: { reference } });
  const unfinishedWorkerStates = new Set([
    "QUEUED",
    "WAITING",
    "PROCESSING",
    "RETRY_SCHEDULED",
    "RETRYING"
  ]);
  const creditedAmountMinor = credits.reduce(
    (total, credit) => total + Number(credit.amountMinor),
    0
  );

  return {
    reference,
    creditCount: credits.length,
    creditedAmountMinor,
    currency: payment?.currency ?? "NGN",
    status: payment?.status ?? "NOT_FOUND",
    pending: !payment || unfinishedWorkerStates.has(payment.workerStatus),
    ledgerEntries: credits.map((credit) => ({
      id: String(credit.id),
      type: String(credit.type),
      amountMinor: Number(credit.amountMinor),
      currency: credit.currency
    }))
  };
}
```

Do not return hardcoded expected values. BachsProof already knows the expected outcome;
your callback must report what the database says really happened.

For example, two ₦5,000 credit records should be reported as `creditCount: 2` and
`creditedAmountMinor: 1000000`. BachsProof will report the duplicate-credit violation.

If a background worker is queued, waiting, processing, or scheduled for retry,
return `pending: true`. The exact status names belong to your application; the
example lists common unfinished states. BachsProof polls for a bounded period.
For negative scenarios, do not return zero credits merely because you expect no
credit while processing is unfinished.

## 5. Enable both helpers

In `bachsproof.config.mjs`, uncomment the generated imports and properties. Keep the
generated provider, target, signing, and tests properties:

```js
import { createPayment } from "./tests/bachsproof.setup.mjs";
import { verify } from "./tests/bachsproof.verify.mjs";

export default {
  provider,
  target,
  ...(signing ? { signing } : {}),
  createPayment,
  verify,
  requireFinancialVerification: true,
  tests
};
```

Do not add a second `export default`; edit the generated one. The requirement flag
makes a scenario fail if committed financial state was not independently checked.

## 6. Run one test, then all tests

```bash
pnpm exec bachsproof test --name "sequential duplicate webhook"
pnpm exec bachsproof test
```

The first scenario sends the same successful event twice and checks that the
application created one credit. The full generated suite contains all 15 scenarios.
BachsProof runs scenarios one after another, while delivery waves inside a scenario
remain concurrent when required.

Run machine-readable output in CI:

```bash
pnpm exec bachsproof test --json
```

The summary reports passed and failed scenarios, financially verified and unverified
scenarios, financial violations, and duration.

If you are debugging setup, enable only `createPayment` first. That checks payment
preparation and webhook delivery, but it is delivery-only. Enable `verify` before
treating a result as a financial correctness result.

## 7. Manual and synthetic references

Automatic preparation is recommended, but not required. Put a real `reference`
directly on a selected test. For `concurrent-unique-payments`, provide one real
reference per participant in `references`.

Synthetic references are available only as an explicit fixture mode:

```powershell
$env:BACHSPROOF_USE_SYNTHETIC_REFERENCES = "true"
pnpm exec bachsproof test --name "sequential duplicate webhook"
```

Synthetic runs check delivery and adapter behavior. They do not prove that a real
application payment exists or that money was persisted correctly.

## 8. Responsibilities

You provide isolated test payment creation, the returned reference, a reader for
committed payment and financial records, and the application URL, path, and test
secret.

BachsProof provides test events, Bachs test signing for the exact request body,
webhook delivery, duplicate/concurrent/delayed/lifecycle scenarios, financial
invariant evaluation, and reports.

BachsProof does not guarantee production readiness. You remain responsible for
webhook security, idempotency, transaction design, reconciliation, and financial
integrity.

## 9. Troubleshooting

**A real application reference is required.** Implement and enable `createPayment`,
or add a real reference to the test definition. Do not use a made-up reference
against a real application.

**Payment preparation failed.** Open `tests/bachsproof.setup.mjs`. Check that the
callback creates a test record and returns a non-empty string. BachsProof sends no
webhook for a scenario whose preparation failed.

**The webhook returns 401 or 400.** Check the test secret, webhook path, and that
your application verifies the original raw body before parsing JSON.

**The test passes delivery but says unverified.** Implement and enable `verify`.
Delivery-only is not proof of a financial write. For asynchronous handlers,
return `pending: true` until committed state is readable.

**The verifier times out.** Return `pending: true` while your worker is processing,
and read committed records from the same isolated test environment.

**Two scenarios reuse a reference.** Create a fresh record for each scenario.
BachsProof rejects accidental reuse so one scenario cannot contaminate another.

For optional deterministic checkpoint testing, see the advanced section in
[`cli.md`](./cli.md). Ordinary black-box delivery is not deterministic race coverage.
