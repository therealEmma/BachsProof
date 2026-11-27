# BachsProof beginner quickstart

This guide takes you from installation to a financially verified test. BachsProof
sends synthetic webhook requests to an isolated copy of your application. It does
not call Bachs, move money, or change your production code.

If you want to see a copy-paste runnable example before connecting your own
database, run the [reference wallet test](first-payment-test.mdx) from this
repository:

```bash
pnpm exec vitest run apps/reference-wallet/tests/wallet.integration.test.ts
```

The steps below show how to connect BachsProof to your own payment or order
tables.

## 1. Install and initialize

```bash
pnpm add -D @bachsproof/cli@1.1.0
pnpm exec bachsproof init
```

The command creates:

- `bachsproof.config.mjs` — the target URL, webhook path, signing, callbacks,
  and named tests;
- `tests/bachsproof.test.mjs` — the scenarios to run;
- `tests/bachsproof.setup.mjs` — your `createPayment` callback;
- `tests/bachsproof.verify.mjs` — your `verify` callback.

The last two files are application test code. The generated functions fail on
purpose until you connect them to your own test database or test service.

## 2. Load the test environment

The CLI reads `process.env`; it does not guess which `.env` file a monorepo
should use. Load the same isolated values into both the application process and
the BachsProof process. For example, from PowerShell:

```powershell
$env:BACHSPROOF_TARGET_URL = "http://127.0.0.1:3000"
$env:BACHSPROOF_WEBHOOK_PATH = "/webhooks/bachs"
$env:BACHS_WEBHOOK_SECRET = "your-test-only-secret"
$env:BACHSPROOF_TEST_DATABASE_URL = "postgresql://user:password@localhost:5432/bachsproof_test"
```

If your monorepo uses a root `.env`, load it with the environment loader already
used by your application before the config reads `process.env` (for example,
`dotenv.config({ path: "../../.env" })`). The application and the callbacks
must use the same `BACHSPROOF_TEST_DATABASE_URL`; otherwise BachsProof may send
the webhook to one database while `verify` reads another.

## 3. Configure the generated file

Keep the generated provider and tests, then enable the callbacks after you
implement them:

```js
import { bachsAdapter } from "@bachsproof/cli";
import { tests } from "./tests/bachsproof.test.mjs";
import { createPayment } from "./tests/bachsproof.setup.mjs";
import { verify } from "./tests/bachsproof.verify.mjs";

const signingSecret = process.env.BACHS_WEBHOOK_SECRET;

export default {
  provider: bachsAdapter({ mode: "mock" }),
  target: {
    baseUrl: process.env.BACHSPROOF_TARGET_URL ?? "http://127.0.0.1:3000",
    webhookPath: process.env.BACHSPROOF_WEBHOOK_PATH ?? "/webhooks/bachs"
  },
  ...(signingSecret ? { signing: { type: "bachs", secret: signingSecret } } : {}),
  createPayment,
  verify,
  requireFinancialVerification: true,
  financialVerification: {
    completionDeadlineMs: 10_000,
    pollIntervalMs: 25,
    negativeObservationWindowMs: 250
  },
  tests
};
```

The signing secret is a test webhook secret, not a Bachs API key. Your webhook
handler must use the same secret and verify the raw request body.

## 4. Prepare a fresh payment with Prisma

`createPayment` is a callback that you implement. `applicationTestApi` is not a
BachsProof API. A callback call must create a fresh, unique application record
before the webhook arrives and return the reference that your handler expects.

Install Prisma in the application if it does not already use it:

```bash
pnpm add @prisma/client
pnpm add -D prisma dotenv
```

Create a small test-only client, for example `tests/test-support/prisma.mjs`:

```js
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: process.env.BACHSPROOF_ENV_FILE ?? ".env" });

const databaseUrl = process.env.BACHSPROOF_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("BACHSPROOF_TEST_DATABASE_URL is required");
}

export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } }
});
```

The explicit datasource URL is important in a monorepo: it prevents the callback
from silently using a developer or production database. Point the target
application at the same URL before starting it.

Replace the intentional error in `tests/bachsproof.setup.mjs` with this example
and change field names to match your schema:

```js
import { randomUUID } from "node:crypto";
import { prisma } from "./test-support/prisma.mjs";

export async function createPayment({
  scenario,
  amountMinor,
  currency,
  paymentIndex,
  paymentCount
}) {
  const reference = `bachsproof-${scenario}-${paymentIndex}-${randomUUID()}`;
  const payment = await prisma.payment.create({
    data: {
      reference,
      amountMinor: BigInt(amountMinor),
      currency,
      status: "PENDING"
    }
  });
  if (!payment?.reference) throw new Error("payment API returned no reference");
  return payment.reference;
}
```

The five context properties are:

| Property | Meaning |
| --- | --- |
| `scenario` | The scenario being executed, such as `sequential-duplicate-webhook`. |
| `amountMinor` | The integer amount expected by that scenario. For NGN, `500_000` is ₦5,000. |
| `currency` | The three-letter currency code, such as `NGN`. |
| `paymentIndex` | Zero-based position of this payment within the scenario. |
| `paymentCount` | Total payments BachsProof needs for the scenario. |

For `concurrent-unique-payments`, `createPayment` runs once per payment, so
`paymentIndex` and a unique reference prevent the payments from sharing state.
For every scenario, a fresh reference prevents one run from contaminating the
next run. The callback must not charge a live instrument or move real money.

If your application calls these records orders, invoices, wallets, or deposits,
create the record whose reference the webhook handler uses. BachsProof does not
require a particular table or ORM.

## 5. Verify committed financial state with Prisma

HTTP `200` or `202` only says that the webhook route responded. `verify` must
read the payment and the committed credit or ledger rows from the same isolated
database. It must report what happened, not what the test expected.

This is the smallest valid response:

```js
export async function verify(reference) {
  return {
    reference,
    creditCount: 0,
    creditedAmountMinor: 0,
    currency: "NGN"
  };
}
```

Use that shape only as a contract example. A real verifier must query the
database. Here is a complete wallet-credit example:

```js
import { prisma } from "./test-support/prisma.mjs";

function toSafeMinorUnits(value) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Financial amount exceeds JavaScript safe integer range");
  }
  return number;
}

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

  return {
    reference,
    creditCount: credits.length,
    creditedAmountMinor: credits.reduce(
      (total, credit) => total + toSafeMinorUnits(credit.amountMinor),
      0
    ),
    currency: payment?.currency ?? "NGN",
    status: payment?.status ?? "NOT_FOUND",
    pending: !payment || unfinishedWorkerStates.has(payment.workerStatus),
    ledgerEntries: credits.map((credit) => ({
      id: String(credit.id),
      type: String(credit.type),
      amountMinor: toSafeMinorUnits(credit.amountMinor),
      currency: credit.currency
    }))
  };
}
```

`ledgerEntries` is optional, but every supplied entry must have `id`, `type`,
and integer `amountMinor`; `currency` is optional. The `type` field is required
by runtime validation even when the array itself is optional.

Use integer minor units throughout. PostgreSQL `BIGINT` values arrive in Prisma
as JavaScript `bigint`, so convert them only after checking
`Number.isSafeInteger`. Do not convert through floating-point major units.

`pending: true` means an asynchronous worker can still change the committed
financial state. A database payment status of `PENDING` does not automatically
mean webhook processing is still running: your application may use that status
for an order lifecycle, or it may have already failed and left the status
unchanged. Read the worker/job state that actually tells you whether processing
is unfinished. BachsProof polls only for the configured bounded deadline; a
negative observation window can catch a late erroneous credit for a short time,
but cannot prove that a future job will never write one.

The callback's `context` contains expected state and delivery information for
diagnostics. It is not evidence. The expected state, observed state, and
invariant result are separate: BachsProof supplies the first, your callback
supplies the second, and the core evaluates the third.

## 6. Run one test, then the suite

```bash
pnpm exec bachsproof test --name "sequential duplicate webhook"
pnpm exec bachsproof test
```

The CLI runs named scenarios in order. Deliveries inside a concurrency scenario
can still overlap. A successful financial verification means the callback
returned valid committed state and all applicable invariants passed. A delivery-
only result is not financial proof.

For CI:

```bash
pnpm exec bachsproof test --json > bachsproof-results.json
```

Use only an isolated application, database, queue, and credentials. For more
detail, see [programmatic testing](advanced/programmatic-api.mdx) and the
[callback reference](api/callbacks.mdx).
