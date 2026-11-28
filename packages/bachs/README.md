# `@bachsproof/bachs`

The Bachs adapter supplies local Bachs-shaped payment events, exact money
helpers, and automatic-signing utilities used by `@bachsproof/cli`.

The adapter is test-only. It does not call Bachs or create provider-side
payments. The CLI creates it automatically; developers normally do not need
to import it.

All tested payment references come from the application's `createPayment()`
callback. Simulated events remain local fixtures and are never a substitute
for an application payment record.
