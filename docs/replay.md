# Replay a test report

A report stores enough information to run the same BachsProof-controlled event
plan again: the scenario, event data, concurrency, checkpoint name, delivery
records, and verification mode.

Replay is useful when a failure is hard to understand or when you want to check
whether a fix changed the result.

Replay does not restore the exact raw request headers or the exact operating
system, network, or database timing. If the application needs an existing
payment reference, create a fresh isolated payment before replaying. BachsProof
does not reset or delete application data.

When a verifier uses a shared test database, clean up only the records belonging
to the replay or create a new test payment. Never replay against production.
