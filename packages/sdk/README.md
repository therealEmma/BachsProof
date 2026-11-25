# @bachsproof/sdk

**Beyond webhook delivery. Verify financial correctness.**

Optional test-only checkpoint instrumentation for BachsProof concurrency tests.
Checkpoints are disabled unless an application explicitly enables the middleware
in an authorized test environment.

```ts
await checkpoint("after-idempotency-check", { key: payment.reference });
```
