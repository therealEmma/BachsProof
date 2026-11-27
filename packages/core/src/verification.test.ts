import { describe, expect, it } from "vitest";
import { verifyWithCallback } from "./verification.js";

describe("callback verification", () => {
  it("validates and normalizes callback state", async () => {
    const state = await verifyWithCallback(async (reference) => ({
      reference,
      creditCount: 1,
      creditedAmountMinor: 5_000_000,
      currency: "NGN"
    }), "PAY-001", 100);
    expect(state.status).toBe("UNKNOWN");
    expect(state.creditCount).toBe(1);
  });

  it("rejects a callback result for the wrong reference", async () => {
    await expect(verifyWithCallback(() => ({
      reference: "PAY-WRONG",
      creditCount: 0,
      creditedAmountMinor: 0,
      currency: "NGN"
    }), "PAY-001", 100)).rejects.toThrow("PAY-WRONG");
  });

  it("reports the invalid nested ledger property and expected type", async () => {
    await expect(verifyWithCallback(() => ({
      reference: "PAY-LEDGER-001",
      creditCount: 1,
      creditedAmountMinor: 5_000_000,
      currency: "NGN",
      ledgerEntries: [{ id: "credit-1", amountMinor: 5_000_000 }]
    }) as unknown as import("./types.js").FinancialVerificationInput, "PAY-LEDGER-001", 100)).rejects.toThrow(
      "ledgerEntries[0].type: expected string, received undefined"
    );
  });

  it("bounds a callback that never resolves", async () => {
    await expect(verifyWithCallback(() => new Promise(() => undefined), "PAY-001", 10)).rejects.toThrow("timed out");
  });

  it("passes scenario context and polls pending state until it is independently complete", async () => {
    let attempts = 0;
    let receivedContext: unknown;
    const state = await verifyWithCallback(async (reference, context) => {
      receivedContext = context;
      attempts += 1;
      if (attempts === 1) return { reference, creditCount: 0, creditedAmountMinor: 0, currency: "NGN", pending: true };
      return { reference, creditCount: 1, creditedAmountMinor: 5_000_000, currency: "NGN" };
    }, "PAY-ASYNC-001", 100, {
      scenario: "delayed-payment-confirmation",
      paymentReference: "PAY-ASYNC-001",
      expected: {
        reference: "PAY-ASYNC-001",
        eligible: true,
        amountMinor: 5_000_000,
        currency: "NGN",
        expectedCreditCount: 1
      },
      expectedOutcome: { eligible: true, expectedCreditCount: 1, amountMinor: 5_000_000, currency: "NGN" },
      events: [],
      eventIdentifiers: [],
      deliveries: []
    }, { pollIntervalMs: 1, isComplete: (observed) => !observed.pending && observed.creditCount === 1 });

    expect(state.creditCount).toBe(1);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(receivedContext).toMatchObject({ scenario: "delayed-payment-confirmation", paymentReference: "PAY-ASYNC-001" });
  });

  it("does not complete an asynchronous verification that remains pending", async () => {
    await expect(verifyWithCallback(async (reference) => ({
      reference,
      creditCount: 0,
      creditedAmountMinor: 0,
      currency: "NGN",
      pending: true
    }), "PAY-PENDING-001", 10, undefined, { pollIntervalMs: 1, isComplete: () => false })).rejects.toThrow("timed out");
  });
});
