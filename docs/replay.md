# Replay

Each report stores the scenario, seed, serialized event, concurrency, checkpoint
name, delivery records, controller trace, and verification mode. Replay runs the
same logical event and controlled checkpoint barrier again; application-owned
test setup must provide a fresh payment record when the target requires one.

When using a callback verifier with an existing Railway database, perform
scoped cleanup or create a fresh payment before replay. PayProof never resets a
target database or calls a target-owned reset endpoint.

Replay is reproducible at the PayProof-controlled checkpoint. It does not promise identical operating-system, network, or database scheduling outside those barriers.
