# Race controller

`RaceController` is the small local service that coordinates an optional
checkpoint test.

In simple English, each webhook request announces “I reached the checkpoint.”
The controller waits until the required number of requests has arrived, then
releases them together. It uses a short-lived session token and a known list of
participants so an unrelated request cannot join the test.

If the required requests do not arrive before the timeout, the controller aborts
the session and releases waiting requests with an HTTP conflict response. This
prevents a test request from hanging forever. Sessions are cleaned up when the
run finishes.

The controller can coordinate separate Node.js processes because requests talk
to it over HTTP. It controls only the named checkpoint. It does not control
every operating-system, network, or database decision, and it cannot make an
unsafe payment write safe.
