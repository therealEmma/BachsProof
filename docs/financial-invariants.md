# Financial invariants

An invariant is a rule that should stay true after a payment is processed. For
example: one customer payment must not create two wallet credits.

BachsProof checks the state returned by your `verify(reference, context)`
callback. The callback must read your committed database or ledger rows. HTTP
`200` is not financial proof.

For an eligible ₦5,000 payment, the usual expected state is:

```text
creditCount: 1
creditedAmountMinor: 500_000
currency: "NGN"
```

| Rule | Plain-English meaning | Example failure |
| --- | --- | --- |
| `INV-001` Unique Credit | One eligible payment creates at most one credit | Two copies of the same payment create two rows |
| `INV-002` Amount Integrity | A credit has the expected total and currency | The order expects 500,000 NGN minor units but the ledger has 499,900 |
| `INV-003` Completion | An eligible payment eventually receives its expected credit | The webhook succeeded but no credit was saved |
| `INV-004` No Unexpected Credit | An ineligible event creates no credit | An expired or failed payment credits the wallet |
| `INV-005` Aggregate Integrity | The total is correct when the expected credit count exists | One row exists, but the total is the wrong amount |

Amounts stay as integer minor units. For NGN, `500_000` means ₦5,000. This
avoids rounding surprises from decimal floating-point values.

For asynchronous applications, return `pending: true` while a worker can still
change the committed state. BachsProof polls for the configured, bounded time.
For an ineligible event, it also waits through a short observation window before
accepting zero credits. A timeout or incomplete verification is a failed,
unverified result, not a financial pass.

See the [invariant reference](/financial-invariants/index) for the exact rule
conditions and examples.
