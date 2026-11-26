# BachsProof reference-wallet engineering demonstration

Date of this report: 2026-11-26.

## The problem

Imagine a customer deposits **₦5,000**. The application should create one
credit of `500_000` kobo. A common unsafe handler does this:

1. Read the payment and see `PENDING`.
2. Add the credit.
3. Mark the payment as completed.

If two webhook requests read `PENDING` before either one saves the new status,
both can add a credit. The wallet then shows ₦10,000 even though the customer
paid once.

The reference wallet keeps both versions of the handler so BachsProof can show
the failure and the fix under the same test schedule.

## What the reference wallet tests

The application accepts Bachs-shaped webhook bodies on the same route in both
modes:

- **Vulnerable mode:** reads first and writes later, with no unique business
  key or atomic transaction around the credit.
- **Corrected mode:** uses storage-specific protection. The in-memory test uses
  a synchronous critical section. The PostgreSQL store uses a transaction and
  a unique idempotency key.

BachsProof pauses both duplicate requests after the payment read, releases them
together, and calls a test-side verifier. The verifier reads the committed
credit rows and wallet state. A successful HTTP response is not treated as
financial proof.

The wallet also demonstrates raw-body signature verification, payment matching,
event ordering, incomplete and expired checkouts, underpayment, failed
collections, and delayed confirmation. These are local synthetic events; the
application does not call Bachs or move money.

## Actual results checked in this workspace

The fast reference-wallet suite passed:

| Implementation | Expected credits | Observed credits | Result |
| --- | ---: | ---: | --- |
| Vulnerable handler | 1 | 2 | Failed with `INV-001`, as intended |
| Corrected handler | 1 | 1 | Passed |

The same suite also passed sequential duplicate delivery, replay, and callback
verification checks. The Bachs-native integration suite passed its five tests.

The full workspace test run reported **14 test files passed, 45 tests passed,
and 2 PostgreSQL tests skipped**. The explicit PostgreSQL run was attempted with
the existing `DATABASE_URL`, but the configured database server was unreachable.
Therefore this report makes no PostgreSQL pass claim.

Run the fast experiment with:

```bash
pnpm exec vitest run apps/reference-wallet/tests/wallet.integration.test.ts
```

Try the PostgreSQL experiment with:

```bash
pnpm exec vitest run apps/reference-wallet/tests/wallet.postgres.integration.test.ts
```

The PostgreSQL suite uses unique references and scoped cleanup. It is skipped
when the database is missing or unreachable. A skipped test is not a database
pass.

## What this evidence means

The result proves that the checked-in reference wallet's vulnerable handler can
save two credits under the controlled schedule and that the corrected handler
saves one. It does not prove that another application is safe, that a live
Bachs payment settled, or that every production schedule is covered.

## Remaining limits

- The current adapter creates synthetic local events and does not call Bachs.
- No live checkout, settlement, provider retry, or reconciliation was tested.
- The checkpoint controls only the named application point; it cannot control
  every operating-system, network, or database decision.
- A finite verification window cannot rule out a later erroneous write.
- The validation host is Node 20.19.2, while the project requires Node 22 or
  later. Build and typecheck passed here with an engine warning; release
  acceptance should also run on a supported Node version.
