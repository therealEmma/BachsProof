# BachsProof

Beyond webhook delivery. Verify financial correctness.

BachsProof is an independent, unofficial test tool for applications that
process Bachs payments. It sends simulated, signed payment webhooks to an
isolated application and reads the payment and ledger records your application
actually saved. It does not call Bachs, move money, or certify production
readiness.

## Install

```bash
pnpm add -D @bachsproof/cli
pnpm exec bachsproof init
```

The command creates one file: `bachsproof.config.mjs`.

You can implement the two callbacks manually or use your preferred [AI coding
agent with the Quickstart prompt](docs/quickstart.mdx#integrate-with-an-ai-coding-agent).

## Configure two callbacks

Set the webhook URL, a test-only secret, amount, and currency. Then implement
the two callbacks in the generated file. In the example, `testApplication` is
your own test-only database helper: `createPayment` inserts a pending payment
and `readFinancialState` reads that payment and its ledger entries.

```js
import { defineConfig } from "@bachsproof/cli";

export default defineConfig({
  webhookUrl: "http://localhost:3000/webhooks/bachs",
  secret: process.env.BACHS_WEBHOOK_SECRET,
  amountMinor: 500000,
  currency: "NGN",

  async createPayment({ amountMinor, currency }) {
    const payment = await testApplication.createPayment({ amountMinor, currency });
    return payment.reference;
  },

  async verify(reference) {
    const state = await testApplication.readFinancialState(reference);
    return {
      reference,
      creditCount: state.credits.length,
      creditedAmountMinor: state.credits.reduce((sum, credit) => sum + credit.amountMinor, 0),
      currency: state.currency,
      status: state.status,
      pending: state.pending,
      ledgerEntries: state.credits.map((credit) => ({
        id: String(credit.id),
        type: String(credit.type),
        amountMinor: credit.amountMinor,
        currency: credit.currency
      }))
    };
  }
});
```

`createPayment()` creates a fresh payment record before a webhook is sent.
`verify()` reads committed records after delivery. Return what the database
contains, not the values you expect to see.

Amounts are integer minor units. `500000` means `NGN 5,000.00` in this
example. BigInt values are accepted when they fit JavaScript's safe integer
range.

## Run the tests

```bash
pnpm exec bachsproof test --name "sequential duplicate webhook"
pnpm exec bachsproof test
pnpm exec bachsproof test --json
```

Without a `--name`, BachsProof runs all eleven scenarios. Every scenario must
complete financial verification before it can pass. A successful HTTP response
alone is never enough.

A failed result explains the expected and observed financial state, for example:

```text
FAIL  Concurrent duplicate credit
      Payment reference: test-payment-123
      Expected: one credit of 500000 NGN minor units when eligible
      Observed: 2 credit(s) totalling 1000000 NGN minor units
      Reason: The same payment was credited more than once.
```

## Safety

Use a separate test application, database, background worker, and webhook
secret. Create fresh test payment records for every scenario. Never point
BachsProof at production. BachsProof does not delete your application data.

Read the [documentation](docs/index.mdx) for the complete Prisma example,
application-side payment concepts, scenario explanations, programmatic API,
troubleshooting, and the [v1 to v2 changelog](docs/resources/changelog.mdx).

## License and disclaimer

MIT. BachsProof is an independent, unofficial project. It is not produced,
endorsed, or certified by Bachs.
