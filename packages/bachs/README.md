# @bachsproof/bachs

**Beyond webhook delivery. Verify financial correctness.**

This package is the Bachs adapter for BachsProof. It provides deterministic
synthetic fixtures shaped like documented Bachs webhook envelopes, plus Zod
parsing and exact decimal-string money helpers. Fixtures are explicitly mock
data; they are not authentic Bachs sandbox deliveries and do not include
fabricated provider signatures.

Use the official `@bachs/sdk` on the application server for real webhook signature verification. BachsProof's reference wallet calls `webhooks.constructEvent` on the original raw request body before parsing it.
