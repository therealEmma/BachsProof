# @bachsproof/sdk

Test-only checkpoint instrumentation for BachsProof. Checkpoints are disabled unless an application explicitly enables the middleware in an authorized test environment.

```ts
await checkpoint("after-idempotency-check", { key: payment.reference });
```
