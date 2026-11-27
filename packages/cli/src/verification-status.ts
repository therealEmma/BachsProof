import type { BachsProofReport } from "@bachsproof/core";

export type FinancialVerificationDisplayStatus =
  | "not-configured"
  | "not-run"
  | "could-not-complete"
  | "completed"
  | "violations";

/**
 * Map the existing report fields to a beginner-friendly CLI status. This is a
 * display helper only; the public report shape remains unchanged.
 */
export function financialVerificationStatus(report: BachsProofReport): FinancialVerificationDisplayStatus {
  if (report.verificationMode === "none") return "not-configured";
  if (report.financiallyVerified) {
    return (report.verification?.violations.length ?? 0) > 0 ? "violations" : "completed";
  }
  if (report.errors.some((error) => error === "Financial verification was required but did not run")) {
    return "not-run";
  }
  if (report.errors.some((error) => error.startsWith("Financial verification"))) {
    return "could-not-complete";
  }
  return "not-run";
}

export function financialVerificationLabel(report: BachsProofReport): string {
  switch (financialVerificationStatus(report)) {
    case "not-configured": return "financial verification not configured";
    case "not-run": return "financial verification configured; did not run";
    case "could-not-complete": return "financial verification attempted; could not complete";
    case "completed": return "financial verification completed";
    case "violations": return "financial verification completed; financial violations detected";
  }
}
