# BachsProof

Test whether your payment webhook handles money correctly.

BachsProof sends safe, test-only payment events to an isolated copy of your
application. It then reads the payment and ledger records that your application
saved and checks the result. It does not call Bachs, move money, or change your
production database.

BachsProof is an independent, unofficial project. Bachs is the first supported
payment provider.

## Why this matters

An HTTP `200` only means that your webhook answered. It does not prove that the
right amount of money was saved.

For example, a customer pays ₦5,000. Two copies of the same webhook arrive at
almost the same time. If both requests read `PENDING` before either request
writes, the wallet may receive ₦10,000 instead of ₦5,000.

BachsProof checks the saved result, not just the HTTP response:

```text
Expected: one credit of 500_000 NGN minor units
Observed: two credits totalling 1_000_000 NGN minor units
Result:   FAIL — the same payment was credited twice
```

## What BachsProof can test

| Test area | Example question |
| --- | --- |
| Repeated webhooks | Does a retry create a second credit? |
| Concurrent webhooks | What happens when two requests overlap? |
| Payment lifecycle | Is an expired, failed, or incomplete payment rejected? |
| Amount and currency | Is the stored order checked before fulfilment? |
| Webhook security | Are invalid signatures, changed bodies, and bad JSON rejected? |
| Financial state | Did the application save one correct credit, or no credit? |

The Bachs adapter currently provides 15 scenarios. See the [scenario guide](docs/scenarios.md).

## Quick start

Use Node.js 22 or later and an isolated test application and database.

```bash
pnpm add -D @bachsproof/cli@1.1.0
pnpm exec bachsproof init
```

The command creates these files in the application repository:

```text
bachsproof.config.mjs
tests/
  bachsproof.test.mjs
  bachsproof.setup.mjs
  bachsproof.verify.mjs
```

Then:

1. Start your application with its test database.
2. Set `BACHSPROOF_TARGET_URL`, `BACHSPROOF_WEBHOOK_PATH`, and your test-only
   `BACHS_WEBHOOK_SECRET`.
3. Implement `createPayment()` so each test gets a fresh payment record.
4. Implement `verify()` so BachsProof can read committed credits or ledger rows.
5. Enable both callbacks in `bachsproof.config.mjs`.
6. Run one scenario, then the full suite:

```bash
pnpm exec bachsproof test --name "sequential duplicate webhook"
pnpm exec bachsproof test
```

The [beginner quickstart](docs/quickstart.md) shows the files, commands, and a
Prisma example in detail.

## The two callbacks you must understand

`createPayment()` prepares a payment record before BachsProof sends a webhook.
It returns the reference that your webhook handler already understands.

```js
import { randomUUID } from "node:crypto";

export async function createPayment({ scenario, amountMinor, currency }) {
  const payment = await testDatabase.payment.create({
    data: {
      reference: `bachsproof-${randomUUID()}`,
      amountMinor,
      currency,
      status: "PENDING",
      testScenario: scenario
    }
  });

  return payment.reference;
}
```

`verify()` reads what the application actually committed. Do not copy expected
values from the test configuration into this callback.

```js
export async function verify(reference) {
  const payment = await testDatabase.payment.findUnique({ where: { reference } });
  const credits = await testDatabase.credit.findMany({ where: { reference } });

  return {
    reference,
    creditCount: credits.length,
    creditedAmountMinor: credits.reduce((sum, credit) => sum + credit.amountMinor, 0),
    currency: payment?.currency ?? "NGN",
    ledgerEntries: credits.map((credit) => ({
      id: String(credit.id),
      type: String(credit.type),
      amountMinor: credit.amountMinor,
      currency: credit.currency
    }))
  };
}
```

`testDatabase` in these examples is your application test database client. The
complete reference-wallet test is in [Your first payment test](docs/first-payment-test.mdx),
and the Prisma version is in the [quickstart](docs/quickstart.md). Amounts use
integer minor units: `500_000` kobo means ₦5,000.

## How a run works

```text
prepare payment → create local Bachs event → send webhook → read saved state → check rules → report
```

Your application still owns signature verification, order matching, database
transactions, idempotency, retries, and fulfilment. BachsProof supplies the
test event and checks the result your application saved.

## Three testing levels

| Level | What it proves | What you need |
| --- | --- | --- |
| Delivery-only | The route receives an event and returns the expected status | Provider, target, and tests |
| Financially verified | The saved credit count, amount, currency, and payment state are correct | A real isolated reference and `verify()` |
| Controlled concurrency | Requests pause at a named test point so a race is easier to reproduce | Optional `@bachsproof/sdk` instrumentation |

Delivery-only testing is a useful first step. It is not financial proof. For CI,
use `requireFinancialVerification: true` after `verify()` reads real committed
state.

## Packages

| Package | Use it for |
| --- | --- |
| `@bachsproof/cli` | The normal `init` and `test` commands |
| `@bachsproof/core` | Calling the runner from Vitest, Jest, or another tool |
| `@bachsproof/bachs` | Bachs-shaped local events, signing, and money helpers |
| `@bachsproof/sdk` | Optional test-only checkpoints for controlled concurrency |

Most projects need only `@bachsproof/cli`.

## Safety

Use a separate application process, database, queue, and webhook secret. Never
send synthetic events to production. BachsProof does not reset or delete your
application data, so your test setup must create isolated records and your test
cleanup must remove them when appropriate.

## More documentation

- [Installation](docs/installation.mdx)
- [Beginner quickstart](docs/quickstart.md)
- [Payment scenarios](docs/scenarios.md)
- [Financial invariants](docs/financial-invariants.md)
- [Programmatic API](docs/advanced/programmatic-api.mdx)
- [Troubleshooting](docs/resources/troubleshooting.mdx)

## Development in this repository

```bash
pnpm install
pnpm test
```

The reference wallet in `apps/reference-wallet` demonstrates both an unsafe
handler and a corrected handler. It is a learning example, not a production
payment application.
