# `@bachsproof/sdk`

Optional test-only checkpoints for repeatable concurrency tests.

In simple English, a checkpoint lets two webhook requests pause at the same
named line. BachsProof releases them together so you can reproduce a race more
often. A checkpoint is not a database lock and cannot repair an unsafe payment
handler.

Install it only in an explicitly enabled test build:

```bash
pnpm add -D @bachsproof/sdk@1.1.0
```

```ts
import { checkpoint } from "@bachsproof/sdk";

await checkpoint("after-payment-read", {
  key: payment.reference
});
```

The application must enable the checkpoint middleware and accept the
`x-bachsproof-*` headers only when a test-mode environment switch is on. Never
enable this trust path in production.

Read the [checkpoint guide](../../docs/advanced/checkpoint-sdk.mdx) for the
Express-style setup, request flow, timeouts, and framework adapter notes.
