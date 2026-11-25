# @payproof/core

Provider-neutral payment correctness testing for TypeScript applications.

The core runner sends serialized provider events to an existing webhook URL,
records every delivery, optionally coordinates an instrumented checkpoint, and
applies financial invariants to state returned by the application's
verify(reference, context) callback.

    import { PayProof } from "@payproof/core";
    import { bachsAdapter } from "@payproof/bachs";

    const payproof = new PayProof({
      provider: bachsAdapter({ mode: "mock" }),
      target: {
        baseUrl: "http://127.0.0.1:3000",
        webhookPath: "/webhooks/bachs"
      },
      verify: async (reference) => readCommittedState(reference),
      financialVerification: {
        completionDeadlineMs: 10_000,
        pollIntervalMs: 25,
        negativeObservationWindowMs: 250
      }
    });

    const result = await payproof.run({
      scenario: "concurrent-duplicate-credit",
      reference: "isolated-test-order-001",
      amountMinor: 5_000_000,
      currency: "NGN"
    });

verify(reference) remains valid. The optional second argument supplies the
scenario, expected outcome, related event identifiers, and delivery records.
The callback must return independently observed committed state. It must not
return hardcoded expected values.

If the callback returns pending: true, the core polls until the configured
bounded deadline. Missing or unsuccessful verification never becomes a
financial pass. Omitting verify is valid for delivery-only testing, but
financiallyVerified is false.

Payment references are real application references by default. Use
createPayment({ scenario, amountMinor, currency, paymentIndex, paymentCount })
for automatic test-record preparation, explicit reference or references for
manual preparation, or syntheticReferences: true for isolated fixture runs.

The core does not reset application state or call a state-inspection endpoint.
The target application owns preparation, isolation, cleanup, and state access.
For optional controlled concurrency testing, install @payproof/sdk only in a
test-enabled application build.
