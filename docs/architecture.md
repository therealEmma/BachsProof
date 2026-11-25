# Architecture

PayProof keeps provider-specific event construction separate from the provider-neutral engine. `@payproof/core` creates a test session, resets or isolates the target state, delivers serialized events with Undici, coordinates the barrier, obtains persisted financial records through either the recommended callback verifier or the legacy HTTP state endpoint, and evaluates financial invariants.

The reference wallet exposes the same webhook path in both modes. The vulnerable mode performs a check, waits at the checkpoint, and then writes an unrestricted credit. The corrected mode performs the check and credit inside a Prisma transaction and writes the payment reference as a unique idempotency key.

The SDK middleware reads PayProof request headers only if the application opts into request-header activation. A normal production process therefore has no controller connection and checkpoint calls are no-ops.
