import { describe, expect, it } from "vitest";
import { verifyPaymentState } from "./invariants.js";

const expected = {
  reference: "PAY-001",
  eligible: true,
  amountMinor: 5_000_000,
  currency: "NGN",
  expectedCreditCount: 1
};

const observed = {
  reference: "PAY-001",
  status: "COMPLETED",
  currency: "NGN",
  creditedAmountMinor: 5_000_000,
  creditCount: 1,
  ledgerEntries: []
};

describe("financial invariants", () => {
  it("accepts one correctly sized credit", () => {
    expect(verifyPaymentState(expected, observed).passed).toBe(true);
  });

  it("detects duplicate credits and amount inflation", () => {
    const result = verifyPaymentState(expected, { ...observed, creditCount: 2, creditedAmountMinor: 10_000_000 });
    expect(result.violations.map((violation) => violation.id)).toEqual(["INV-001", "INV-002"]);
  });

  it("detects a single credit with the wrong amount", () => {
    const result = verifyPaymentState(expected, { ...observed, creditedAmountMinor: 4_999_999 });
    expect(result.violations.map((violation) => violation.id)).toEqual(["INV-002", "INV-005"]);
  });

  it("detects an unexpected credit", () => {
    const result = verifyPaymentState({ ...expected, eligible: false, expectedCreditCount: 0 }, observed);
    expect(result.violations.map((violation) => violation.id)).toContain("INV-004");
  });
});
