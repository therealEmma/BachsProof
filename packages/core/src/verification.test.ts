import { describe, expect, it } from "vitest";
import { normalizeCallbackState, verifyWithCallback } from "./verification.js";

describe("callback verification", () => {
  it("accepts safe BigInt minor units", () => {
    expect(normalizeCallbackState({
      reference: "PAY-001",
      creditCount: 1,
      creditedAmountMinor: 5_000_000n,
      currency: "NGN"
    }).creditedAmountMinor).toBe(5_000_000);
  });

  it("rejects a callback result for the wrong reference", async () => {
    await expect(verifyWithCallback(() => ({
      reference: "PAY-WRONG",
      creditCount: 0,
      creditedAmountMinor: 0,
      currency: "NGN"
    }), "PAY-001", 100)).rejects.toThrow("PAY-WRONG");
  });

  it("rejects missing ledger evidence instead of filling defaults", () => {
    expect(() => normalizeCallbackState({
      reference: "PAY-LEDGER-001",
      creditCount: 1,
      creditedAmountMinor: 5_000_000,
      currency: "NGN",
      ledgerEntries: [{ id: "credit-1", amountMinor: 5_000_000 }]
    })).toThrow("ledgerEntries[0].type");
  });

  it("polls pending state until the application reports a completed result", async () => {
    let attempts = 0;
    const state = await verifyWithCallback(async (reference) => {
      attempts += 1;
      if (attempts === 1) return { reference, creditCount: 0, creditedAmountMinor: 0, currency: "NGN", pending: true };
      return { reference, creditCount: 1, creditedAmountMinor: 5_000_000, currency: "NGN" };
    }, "PAY-ASYNC-001", 100, undefined, { pollIntervalMs: 1, isComplete: (observed) => !observed.pending && observed.creditCount === 1 });

    expect(state.creditCount).toBe(1);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it("bounds a verifier that remains pending", async () => {
    await expect(verifyWithCallback(async (reference) => ({
      reference,
      creditCount: 0,
      creditedAmountMinor: 0,
      currency: "NGN",
      pending: true
    }), "PAY-PENDING-001", 10, undefined, { pollIntervalMs: 1, isComplete: () => false })).rejects.toThrow("timed out");
  });
});
