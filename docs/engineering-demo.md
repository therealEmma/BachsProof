# PayProof engineering demonstration

Date of this report: 2026-11-24.

## Problem

Webhook handlers often implement payment idempotency as a read followed by a write:

1. Read whether a payment reference was completed.
2. Credit the wallet.
3. Mark the payment completed.

Two concurrent deliveries can both observe `PENDING` and both commit credits. A sequential unit or integration test usually runs the first request to completion before starting the second, so it never creates the interleaving that matters.

PayProof makes that interleaving explicit. Two requests pause after the idempotency read, the controller confirms both arrivals, and both are released together. The test verifies committed ledger rows and the wallet balance rather than treating two HTTP 200 responses as proof of correctness.

## Bachs-specific boundary

The reference wallet receives Bachs-shaped webhook envelopes. The provider adapter serializes only the documented envelope, not its local normalized fields. In signature-enabled mode, the route verifies the original request bytes with the official SDK before JSON parsing. The code does not fabricate live Bachs events or call live payment APIs.

The implementation covers the verified one-time payment signals `checkout.completed`, `checkout.expired`, `collection.succeeded`, `collection.underpaid`, and `collection.failed`. `checkout.completed` and `collection.succeeded` can reference the same `charge_id`/checkout and are intentionally tested as distinct event IDs. Incomplete/expired delivery is non-fulfilling; a later eligible success may fulfil it. The typed underpayment fixture uses the documented paid, expected, and remaining decimal-string fields and remains non-fulfilling.

Amounts are parsed as decimal strings into exact `bigint` coefficients and explicit scales. No provider amount is converted through floating-point arithmetic. PostgreSQL stores the resulting integer amount and scale as `BIGINT` + `amountScale`.

## Vulnerable sequence

```text
delivery A: read Payment(PENDING)
delivery B: read Payment(PENDING)
delivery A: barrier arrival
delivery B: barrier arrival
controller: release both
delivery A: insert WalletCredit, increment Wallet, mark Payment(COMPLETED)
delivery B: insert another WalletCredit, increment Wallet, mark Payment(COMPLETED)
```

The vulnerable handler intentionally has no unique idempotency key and no atomic transaction. It remains in the repository so the demonstration proves that PayProof can fail a real persisted implementation.

## Corrected strategy

The corrected path uses two identities:

- `WebhookEvent.eventId` deduplicates one Bachs delivery.
- `WalletCredit.idempotencyKey` is derived from the local payment reference, so distinct Bachs events for one financial payment cannot create distinct credits.

After the checkpoint, a short PostgreSQL transaction:

1. Re-reads the payment.
2. Inserts the webhook event identity.
3. Records non-fulfilling/out-of-order state without downgrading a completed payment.
4. Inserts the unique wallet credit.
5. Increments the wallet balance.
6. Marks the payment completed and the webhook event processed.

All financial effects commit or roll back together. The checkpoint is outside that transaction, so a barrier timeout cannot hold a database transaction open. Initialization uses find/create with bounded retry around unique-key races instead of relying on a concurrent Prisma upsert.

## Actual local evidence

The following commands were run in this workspace:

```text
pnpm exec vitest run
  14 test files passed
  42 tests passed and 2 PostgreSQL tests skipped because Vitest does not load
  the repository .env automatically

pnpm vitest run apps/reference-wallet/tests/wallet.integration.test.ts
  vulnerable controlled race: failed as expected with 2 committed credits
  corrected controlled race: passed with 1 committed credit
  sequential duplicate and replay: passed
  callback verification: passed

pnpm vitest run apps/reference-wallet/tests/bachs-native.integration.test.ts
  5 tests passed
  raw-body signature acceptance and tamper rejection
  exact decimal parsing
  checkout.completed + collection.succeeded duplicate financial effect
  expired/incomplete delivery followed by delayed success
  malformed input and test-route authentication

TypeScript checks for all workspace packages: passed.

Prisma schema validation with a non-secret placeholder DATABASE_URL: passed.

`pnpm pack:check` passed, rebuilding the workspace and regenerating the core,
SDK, Bachs, and CLI archives. The independent-repository packaging test passed
after installing those fresh archives and running the installed CLI.

The PostgreSQL suite was then run with the quoted `DATABASE_URL` from `.env`
explicitly loaded into the test process:

```text
pnpm exec vitest run apps/reference-wallet/tests/wallet.postgres.integration.test.ts
  2 tests passed
  vulnerable handler: duplicate committed credits detected
  corrected handler: exactly one committed credit
```
```

The fast suite is in-memory and demonstrates application behavior and the exact
race schedule. The separate PostgreSQL suite below is the evidence for the
committed database rows.

## PostgreSQL evidence status

The PostgreSQL integration suite uses Railway or any supplied `DATABASE_URL`,
the checked-in migrations, unique per-run references/customer IDs, and scoped
cleanup. It contains separate vulnerable and corrected assertions against
committed `WalletCredit` rows. The default Vitest command still skips this file
because the repository does not auto-load `.env`; the explicit run above proves
the supplied database configuration works. This suite does not represent a
live Bachs checkout, settlement, or provider retry.

## Remaining limitations

- The host used for this run is Node 20.19.2; the project and official Bachs SDK target Node 22+. The test suite passed on the available host, but Node 22/24 acceptance was not run here.
- The host used for this run allowed the build only with normal child-process permissions outside the restricted sandbox; the build itself passed. A Node 22/24 environment should still be used for release acceptance because this host is Node 20.
- No live Bachs sandbox checkout, real webhook forwarding, settlement, retry delivery, or provider reconciliation was executed.
- Synthetic lifecycle fixtures are not live Bachs sandbox deliveries and do not prove provider-side settlement or retry behavior.
- The checkpoint controls named instrumented barriers; it does not make arbitrary operating-system, network, or database scheduling deterministic.
