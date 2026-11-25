# Architecture

PayProof keeps provider-specific event construction separate from the provider-neutral engine. `@payproof/core` creates a test session, delivers serialized events with Undici, coordinates the optional barrier, obtains persisted financial records through the application-supplied callback verifier, and evaluates financial invariants. Payment preparation and cleanup remain application-owned so PayProof does not require a database or a target-specific reset route.

The reference wallet exposes the same webhook path in both modes. The vulnerable mode performs a check, waits at the checkpoint, and then writes an unrestricted credit. The corrected mode performs the check and credit inside a Prisma transaction and writes the payment reference as a unique idempotency key.

The SDK middleware reads PayProof request headers only if the application opts into request-header activation. A normal production process therefore has no controller connection and checkpoint calls are no-ops.
