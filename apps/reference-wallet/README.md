# Reference wallet

This small Express application demonstrates the BachsProof v2 workflow with
real database-shaped financial evidence.

`createReferenceWallet()` exposes `createPayment()` for an isolated pending
payment and the wallet store exposes `inspect(reference)` for the verification
callback. The `corrected` mode uses event identity, payment idempotency, and a
transaction-shaped write. The `vulnerable` mode intentionally uses an unsafe
check-then-credit path so ordinary concurrent delivery can expose a duplicate
credit. Ordinary concurrency is not deterministic; a passing vulnerable run
does not prove that every possible race is safe.

The Prisma schema is in `prisma/schema.prisma`. The application only accepts
test webhook traffic and never contacts Bachs.
