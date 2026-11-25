# @payproof/core

Provider-neutral orchestration, checkpoint coordination, financial invariants, reports, and replay for PayProof.

The recommended configuration supplies `verify(reference, context)`, which
returns committed credit information directly from the application's own test
database code. The optional `context` identifies the scenario, expected
financial outcome, related provider event IDs, and delivery results; the
one-argument `verify(reference)` form remains compatible. Return `pending: true`
while asynchronous processing is incomplete. The older
`verification.endpoint` HTTP adapter remains available for applications that
prefer an isolated inspection route. Omitting both is valid for basic
webhook/event testing, but `report.financiallyVerified` will be `false`.

For application-owned test payment records, provide
`createPayment({ scenario, amountMinor, currency, paymentIndex, paymentCount })`
when constructing `PayProof`. The runner calls it only when a selected run has
no explicit reference, validates the returned non-empty reference, and prepares
one reference per participant for `concurrent-unique-payments`. Explicit
references take precedence; `syntheticReferences: true` intentionally skips the
callback for fixture-only runs. A callback failure produces a failed report and
sends no webhook.
