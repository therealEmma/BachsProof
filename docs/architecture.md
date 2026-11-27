# How BachsProof is organized

BachsProof keeps four jobs separate:

1. **The CLI** loads your config and prints results.
2. **The Bachs adapter** creates local Bachs-shaped test events.
3. **The core runner** sends events, waits for your verifier, and checks the
   financial rules.
4. **Your application** verifies the webhook, writes its payment state, and
   exposes that state to the test-side `verify()` callback.

```text
CLI → core runner → Bachs-shaped test event → your webhook → your database
                                      ↘ verify() → financial rules → report
```

The adapter is provider-specific. The core runner is provider-independent. This
means the runner does not need to know whether your application uses a wallet
table, an order table, a ledger, Prisma, PostgreSQL, or another system.

Payment preparation, database isolation, cleanup, signature verification,
idempotency, and fulfilment remain application responsibilities.

## Reference wallet

The reference wallet includes a deliberately unsafe handler and a corrected
handler. The unsafe version can create two credits when two requests read the
same pending payment. The corrected version uses a database transaction and a
unique payment key.

## Checkpoints

The optional SDK can let requests pause at a named test line. It is useful for
reproducing a race, but it is not a database lock, an authorization system, or a
production feature. Checkpoint headers are accepted only when the application
explicitly enables test mode.
