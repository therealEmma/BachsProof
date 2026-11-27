import { describe, expect, it } from "vitest";
import type { BachsProofReport } from "@bachsproof/core";
import { financialVerificationStatus } from "./verification-status.js";

function makeReport(overrides: Partial<BachsProofReport> = {}): BachsProofReport {
  return {
    reportVersion: "1.1",
    scenario: "sequential-duplicate-webhook",
    provider: "Bachs",
    mode: "mock",
    paymentReference: "PAY-001",
    event: { reference: "PAY-001", amountMinor: 500_000, currency: "NGN", status: "SUCCEEDED" },
    expected: { reference: "PAY-001", eligible: true, amountMinor: 500_000, currency: "NGN", expectedCreditCount: 1 },
    verificationMode: "none",
    financiallyVerified: false,
    deliveries: [],
    checkpoints: [],
    errors: [],
    replay: { seed: "test", concurrency: 1, controlled: false, note: "test" },
    startedAt: new Date(0).toISOString(),
    ...overrides
  };
}

describe("CLI financial verification status", () => {
  it("distinguishes an unconfigured verifier", () => {
    expect(financialVerificationStatus(makeReport())).toBe("not-configured");
  });

  it("distinguishes a configured verifier that did not run", () => {
    expect(financialVerificationStatus(makeReport({ verificationMode: "callback" }))).toBe("not-run");
  });

  it("distinguishes an attempted verifier that could not complete", () => {
    expect(financialVerificationStatus(makeReport({
      verificationMode: "callback",
      errors: ["Financial verification callback returned invalid data at ledgerEntries[0].type: expected string, received undefined"]
    }))).toBe("could-not-complete");
  });

  it("distinguishes a completed verification from completed violations", () => {
    expect(financialVerificationStatus(makeReport({ verificationMode: "callback", financiallyVerified: true, verification: { passed: true, violations: [] } }))).toBe("completed");
    expect(financialVerificationStatus(makeReport({
      verificationMode: "callback",
      financiallyVerified: true,
      verification: { passed: false, violations: [{ id: "INV-001", name: "duplicate", message: "duplicate", reference: "PAY-001" }] }
    }))).toBe("violations");
  });
});
