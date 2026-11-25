# Replay

Each report stores the scenario, seed, serialized event, concurrency, checkpoint name, delivery records, controller trace, and verification mode. `await payproof.replay(report)` resets the target state when the target allows it and runs the same logical event and controlled checkpoint barrier again.

When using a callback verifier with an existing Railway database, set `target.reset: false` and perform scoped cleanup around the test. This avoids a database-wide reset while preserving replay of the controlled event schedule.

Replay is reproducible at the PayProof-controlled checkpoint. It does not promise identical operating-system, network, or database scheduling outside those barriers.
