# `@bachsproof/core`

This package contains the internal, provider-neutral execution engine used by
the CLI. Ordinary developers should install `@bachsproof/cli` instead.

The engine prepares application payment references, sends provider events,
delivers them sequentially or concurrently, polls asynchronous verification,
and evaluates the five financial invariants. It does not create payment
records or infer ledger state; those responsibilities stay in the callbacks.

The active v2 workspace exposes this engine through the CLI's small two-callback
configuration.
