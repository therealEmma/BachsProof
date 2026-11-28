import { describe, expect, it } from "vitest";
import type { BachsProofCliRun } from "./types.js";
import { formatHumanReadableReport, formatMoney, shouldUseColor } from "./formatter.js";

function fixtureRun(overrides: Partial<BachsProofCliRun["result"]["report"]> = {}, passed = true): BachsProofCliRun {
  const expected = overrides.expected ?? {
    reference: "FIXTURE-PAYMENT-001",
    eligible: true,
    amountMinor: 500_000,
    currency: "NGN",
    expectedCreditCount: 1
  };
  const report = {
    reportVersion: "2.0" as const,
    scenario: "sequential-duplicate-webhook" as const,
    provider: "Bachs",
    paymentReference: expected.reference,
    event: {
      reference: expected.reference,
      amountMinor: expected.amountMinor,
      currency: expected.currency,
      status: "SUCCEEDED"
    },
    expected,
    observed: {
      reference: expected.reference,
      status: "PAID",
      currency: expected.currency,
      creditedAmountMinor: expected.amountMinor,
      creditCount: expected.expectedCreditCount,
      ledgerEntries: []
    },
    verification: { passed: true, violations: [] },
    financiallyVerified: true,
    deliveries: [{
      deliveryId: "delivery-1",
      participantId: "sequential-1",
      reference: expected.reference,
      eventId: "evt-fixture-001",
      eventType: "collection.succeeded",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.010Z",
      status: 200
    }],
    errors: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.042Z",
    ...overrides
  };
  return { name: "Sequential duplicate webhook", scenario: report.scenario, result: { passed, report } };
}

describe("CLI human-readable formatter", () => {
  it("formats minor units using the currency scale without floating-point output", () => {
    expect(formatMoney(500_000, "NGN")).toBe("NGN 5,000.00");
    expect(formatMoney(1, "JPY")).toBe("JPY 1");
    expect(formatMoney(1_234, "BHD")).toBe("BHD 1.234");
  });

  it("reports an ineligible expectation as zero and does not invent missing evidence", () => {
    const run = fixtureRun({
      scenario: "incomplete-checkout",
      paymentReference: "FIXTURE-FREE-001",
      expected: {
        reference: "FIXTURE-FREE-001",
        eligible: false,
        amountMinor: 0,
        currency: "NGN",
        expectedCreditCount: 0
      },
      observed: undefined,
      financiallyVerified: false,
      verification: undefined,
      deliveries: [],
      failureType: "financial-verification-timeout",
      errors: ["Financial verification timed out after 10ms"]
    }, false);
    const output = formatHumanReadableReport([run], {
      total: 1,
      passed: 0,
      failed: 1,
      financiallyVerified: 0,
      financiallyUnverified: 1,
      financialViolations: 0,
      durationMs: 42
    }, { useColor: false });

    expect(output).toContain("Expected: 0 credit(s), totalling NGN 0.00 (0 minor units) (ineligible)");
    expect(output).toContain("Observed: unavailable (financial verification did not complete)");
    expect(output).toContain("Failure type: Verification timeout");
    expect(output).not.toContain("Observed: 0 credit(s)");
    expect(output).toContain("Financial correctness: UNVERIFIED");
  });

  it("separates an expected negative-scenario rejection from financial correctness", () => {
    const run = fixtureRun({
      deliveries: [{
        ...fixtureRun().result.report.deliveries[0]!,
        status: 422,
        expectedStatus: [200, 400, 422],
        deliveryOutcome: "expected-rejection",
        responseBody: "{\"error\":\"amount rejected\"}"
      }]
    });
    const output = formatHumanReadableReport([run], {
      total: 1,
      passed: 1,
      failed: 0,
      financiallyVerified: 1,
      financiallyUnverified: 0,
      financialViolations: 0,
      durationMs: 42
    }, { useColor: false });

    expect(output).toContain("ALLOWED REJECTION HTTP 422");
    expect(output).toContain("Expected: HTTP 200, 400, 422");
    expect(output).toContain("Response body: {\"error\":\"amount rejected\"}");
    expect(output).toContain("Financial correctness: PASS");
  });

  it("shows fixture-based invariant evidence and compact full-suite failures", () => {
    const passing = fixtureRun();
    const failing = fixtureRun({
      scenario: "concurrent-duplicate-credit",
      paymentReference: "FIXTURE-DUPLICATE-001",
      observed: {
        reference: "FIXTURE-DUPLICATE-001",
        status: "PAID",
        currency: "NGN",
        creditedAmountMinor: 1_000_000,
        creditCount: 2,
        ledgerEntries: []
      },
      verification: {
        passed: false,
        violations: [{
          id: "INV-001",
          name: "Unique Credit",
          message: "Payment FIXTURE-DUPLICATE-001 created 2 credits; one credit is allowed for an eligible payment",
          reference: "FIXTURE-DUPLICATE-001"
        }]
      },
      financiallyVerified: true,
      errors: ["INV-001: Payment FIXTURE-DUPLICATE-001 created 2 credits"],
      failureType: "invariant-violation",
      deliveries: [
        { ...fixtureRun().result.report.deliveries[0]!, participantId: "participant-1" },
        { ...fixtureRun().result.report.deliveries[0]!, deliveryId: "delivery-2", participantId: "participant-2" }
      ]
    }, false);
    const output = formatHumanReadableReport([passing, failing], {
      total: 2,
      passed: 1,
      failed: 1,
      financiallyVerified: 2,
      financiallyUnverified: 0,
      financialViolations: 1,
      durationMs: 84
    }, { useColor: false });

    expect(output).toContain("Scenario summary");
    expect(output).toContain("Failure details");
    expect(output).toContain("INV-001 Unique Credit");
    expect(output).toContain("Financial discrepancies:");
    expect(output).toContain("Expected: 1 credit(s), totalling NGN 5,000.00");
    expect(output).toContain("Observed: 2 credit(s), totalling NGN 10,000.00");
  });

  it("supports colors explicitly while disabling them for CI and NO_COLOR", () => {
    const output = formatHumanReadableReport([fixtureRun()], {
      total: 1,
      passed: 1,
      failed: 0,
      financiallyVerified: 1,
      financiallyUnverified: 0,
      financialViolations: 0,
      durationMs: 42
    }, { useColor: true });
    expect(output).toContain("\u001b[32mPASS\u001b[0m");
    expect(shouldUseColor({ CI: "true" }, true)).toBe(false);
    expect(shouldUseColor({ NO_COLOR: "" }, true)).toBe(false);
  });
});
