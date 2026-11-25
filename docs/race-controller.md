# Race controller

`RaceController` is a small HTTP barrier service. A session has an opaque token and an explicit participant list. Each checkpoint arrival is authenticated, recorded, and held as an open HTTP response. The orchestrator waits for the required participant count and then calls `release`, which completes all held responses.

Timeouts reject the orchestrator wait. Aborting a session completes pending checkpoint responses with HTTP 409 so application requests do not hang indefinitely. Sessions are cleaned up in the orchestrator `finally` block and controller shutdown aborts any remaining session.

This coordinates separate Node.js processes because the SDK communicates over HTTP. It controls only instrumented points; it cannot make arbitrary OS, network, or database scheduling deterministic.
