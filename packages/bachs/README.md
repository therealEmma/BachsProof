# `@bachsproof/bachs`

The Bachs adapter for BachsProof.

It creates local test events shaped like the documented Bachs webhook payloads,
serializes amounts using integer minor units, and creates test signatures when
the runner is configured to sign them. The default `mode: "mock"` does not call
Bachs and does not create a real payment.

```ts
import { bachsAdapter } from "@bachsproof/bachs";

const provider = bachsAdapter({ mode: "mock" });
```

Your application still needs to verify real Bachs webhooks with the official
Bachs SDK. Verify the original raw request body before parsing it. BachsProof
fixtures are useful for testing your handler; they are not proof of provider
settlement and they do not replace a sandbox payment.

For event eligibility, money values, signing, and the supported scenarios, see
the [Bachs integration guide](../../docs/bachs/index.mdx).
