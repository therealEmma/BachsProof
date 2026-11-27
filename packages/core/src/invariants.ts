import type { ExpectedPaymentState, ObservedPaymentState, VerificationResult } from "./types.js";

/**
 * Evaluate persisted financial state, not merely webhook HTTP responses.
 * Every comparison uses integer minor units so a floating-point rounding error
 * cannot hide a duplicate or incorrect credit.
 */
export function verifyPaymentState(expected: ExpectedPaymentState, observed: ObservedPaymentState): VerificationResult {
  // A single run can violate more than one invariant; retaining all failures
  // makes the report useful for debugging instead of stopping at the first one.
  const violations = [];
  if (observed.creditCount > 1) {
    violations.push({
      id: "INV-001" as const,
      name: "Unique Credit",
      message: `Payment ${expected.reference} created ${observed.creditCount} credits; one credit is allowed for an eligible payment`,
      reference: expected.reference
    });
  }
  if (observed.creditCount > 0 && (observed.creditedAmountMinor !== expected.amountMinor || observed.currency !== expected.currency)) {
    violations.push({
      id: "INV-002" as const,
      name: "Amount Integrity",
      message: `Expected ${expected.amountMinor} ${expected.currency} minor units, but observed ${observed.creditedAmountMinor} ${observed.currency} minor units`,
      reference: expected.reference
    });
  }
  if (expected.eligible && observed.creditCount < expected.expectedCreditCount) {
    violations.push({
      id: "INV-003" as const,
      name: "Completion",
      message: `Expected ${expected.expectedCreditCount} credit for ${expected.reference}, but observed ${observed.creditCount}`,
      reference: expected.reference
    });
  }
  if (!expected.eligible && observed.creditCount > 0) {
    violations.push({
      id: "INV-004" as const,
      name: "No Unexpected Credit",
      message: `Payment ${expected.reference} was not eligible, but it created ${observed.creditCount} credit(s)`,
      reference: expected.reference
    });
  }
  if (expected.eligible && observed.creditCount === expected.expectedCreditCount && observed.creditedAmountMinor !== expected.amountMinor) {
    violations.push({
      id: "INV-005" as const,
      name: "Aggregate Integrity",
      message: `Payment ${expected.reference} has the expected number of credits, but their total is not the expected amount`,
      reference: expected.reference
    });
  }
  return { passed: violations.length === 0, violations };
}
