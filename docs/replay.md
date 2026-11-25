# Replay

Each report stores the scenario, seed, structured event, concurrency, checkpoint
name, delivery records, controller trace, and verification mode. Replay
re-serializes the structured event and runs the controlled checkpoint barrier
again; it does not store the exact raw body or every request header. Application-
owned test setup must provide a fresh payment record when the target requires
one.

When using a callback verifier with an existing Railway database, perform
scoped cleanup or create a fresh payment before replay. BachsProof never resets a
target database or calls a target-owned reset endpoint.

Replay is reproducible at the BachsProof-controlled checkpoint. It does not promise identical operating-system, network, or database scheduling outside those barriers.
