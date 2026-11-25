# Financial invariants

- `INV-001` Unique Credit: one eligible payment reference has at most one posted credit.
- `INV-002` Amount Integrity: the posted amount and currency equal the expected integer minor-unit values.
- `INV-003` Completion: an eligible payment receives its expected credit.
- `INV-004` No Unexpected Credit: an ineligible payment receives no credit.
- `INV-005` Aggregate Integrity: the observed amount for the payment equals the expected amount.

The verifier takes state returned either by the recommended `verify(reference, context)` callback or by the legacy `verify(reference)` callback / application inspection endpoint. The second callback argument is optional for backward compatibility and identifies the scenario, expected outcome, related provider event IDs, and delivery records for the reference. Callback values are validated with Zod before evaluation. HTTP success is not treated as financial success. Individual references are checked, and amounts remain integer minor units throughout.

For asynchronous applications, return `{ pending: true, ... }` until committed state is readable. PayProof polls for the configured bounded completion window. Negative scenarios also use a short observation window, so an immediate zero-credit response is not treated as proof that a delayed handler will never create a credit. If state remains pending when the deadline expires, the run is unverified and fails rather than being converted into a financial pass.
