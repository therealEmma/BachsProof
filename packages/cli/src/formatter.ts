import type { BachsProofReport, BachsProofResult, DeliveryOutcome, DeliveryRecord, ExpectedHttpStatus, ExpectedPaymentState, FinancialOutcome, InvariantViolation, ObservedPaymentState } from "@bachsproof/core";
import type { BachsProofCliRun, BachsProofSummary } from "./types.js";

export const BACHS_PROOF_VERSION = "2.1.0";

export interface HumanReadableReportOptions {
  useColor?: boolean;
  redact?: (value: string) => string;
}

const ANSI = {
  reset: "\u001b[0m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m"
} as const;

function color(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

export function shouldUseColor(environment: NodeJS.ProcessEnv = process.env, isTTY = process.stdout.isTTY): boolean {
  return Boolean(isTTY) && environment.NO_COLOR === undefined && environment.CI === undefined;
}

function currencyScale(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function groupInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format minor units without converting them through floating-point arithmetic. */
export function formatMoney(minorUnits: number, currency: string): string {
  if (!Number.isSafeInteger(minorUnits)) return `${currency} unavailable`;
  const scale = currencyScale(currency);
  const negative = minorUnits < 0;
  const digits = (negative ? -BigInt(minorUnits) : BigInt(minorUnits)).toString().padStart(scale + 1, "0");
  const split = digits.length - scale;
  const whole = groupInteger(digits.slice(0, split));
  if (scale === 0) return `${currency} ${negative ? "-" : ""}${whole}`;
  return `${currency} ${negative ? "-" : ""}${whole}.${digits.slice(split)}`;
}

function exactAmount(minorUnits: number, currency: string): string {
  return `${formatMoney(minorUnits, currency)} (${minorUnits} minor units)`;
}

function expectedDescription(expected: ExpectedPaymentState): string {
  const eligibility = expected.eligible ? "eligible" : "ineligible";
  return `${expected.expectedCreditCount} credit(s), totalling ${exactAmount(expected.amountMinor, expected.currency)} (${eligibility})`;
}

function observedDescription(observed: ObservedPaymentState | undefined): string {
  if (!observed) return "unavailable (financial verification did not complete)";
  return `${observed.creditCount} credit(s), totalling ${exactAmount(observed.creditedAmountMinor, observed.currency)}; currency ${observed.currency}; status ${observed.status}`;
}

function failureLabel(report: BachsProofReport): string | undefined {
  switch (report.failureType) {
    case "payment-preparation": return "Payment preparation failure";
    case "webhook-delivery": {
      const outcomes = report.deliveries.map((delivery) => recordedDeliveryOutcome(delivery));
      if (outcomes.includes("network-failure")) return "Network failure";
      return "Webhook delivery failure";
    }
    case "unexpected-http-response": {
      const outcomes = report.deliveries.map((delivery) => recordedDeliveryOutcome(delivery));
      if (outcomes.includes("authentication-failure")) return "Authentication or authorization failure";
      if (outcomes.includes("rate-limit-failure")) return "Rate-limiting failure";
      if (outcomes.includes("infrastructure-failure")) return "Server-side failure";
      if (outcomes.includes("network-failure")) return "Network failure";
      return "Unexpected HTTP response";
    }
    case "financial-verification": return "Financial verification failure";
    case "financial-verification-timeout": return "Verification timeout";
    case "invariant-violation": return "Financial invariant violation";
    default: return undefined;
  }
}

function statusLabel(result: BachsProofResult, enabled: boolean): string {
  return color(result.passed ? "PASS" : "FAIL", result.passed ? ANSI.green : ANSI.red, enabled);
}

function recordedDeliveryOutcome(delivery: DeliveryRecord): DeliveryOutcome {
  if (delivery.deliveryOutcome) return delivery.deliveryOutcome;
  if (delivery.status === undefined) return "infrastructure-failure";
  if (delivery.error) {
    if (delivery.status === 401 || delivery.status === 403) return "authentication-failure";
    if (delivery.status === 429) return "rate-limit-failure";
    if (delivery.status >= 500 && delivery.status < 600) return "infrastructure-failure";
    return "unexpected-http-response";
  }
  if (delivery.status >= 200 && delivery.status < 300) return "passed";
  return delivery.expectedStatus !== undefined
    && delivery.status >= 400
    && delivery.status < 500
    && delivery.status !== 401
    && delivery.status !== 403
    && delivery.status !== 429
    ? "expected-rejection"
    : "unexpected-http-response";
}

function deliveryOutcomeLabel(outcome: DeliveryOutcome): { text: string; color: string } {
  switch (outcome) {
    case "expected-rejection": return { text: "ALLOWED REJECTION", color: ANSI.yellow };
    case "authentication-failure": return { text: "AUTHENTICATION/AUTHORIZATION FAILURE", color: ANSI.red };
    case "rate-limit-failure": return { text: "RATE-LIMITING FAILURE", color: ANSI.red };
    case "network-failure": return { text: "NETWORK FAILURE", color: ANSI.red };
    case "infrastructure-failure": return { text: "SERVER-SIDE FAILURE", color: ANSI.red };
    case "unexpected-http-response": return { text: "FAIL", color: ANSI.red };
    default: return { text: "PASS", color: ANSI.green };
  }
}

function deliveryStatus(delivery: DeliveryRecord, enabled: boolean): string {
  const outcome = deliveryOutcomeLabel(recordedDeliveryOutcome(delivery));
  const outcomeText = color(outcome.text, outcome.color, enabled);
  return `${outcomeText}${delivery.status === undefined ? "" : ` HTTP ${delivery.status}`}`;
}

function financialOutcome(report: BachsProofReport): FinancialOutcome {
  // A PASS or FAIL requires both the completion flag and actual verification
  // evidence. Missing evidence is always UNVERIFIED.
  if (!report.financiallyVerified || !report.verification) return "UNVERIFIED";
  return report.verification.passed ? "PASS" : "FAIL";
}

function financialOutcomeText(report: BachsProofReport, enabled: boolean): string {
  const outcome = financialOutcome(report);
  const ansi = outcome === "PASS" ? ANSI.green : outcome === "FAIL" ? ANSI.red : ANSI.yellow;
  return color(outcome, ansi, enabled);
}

function responseBodyText(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact;
}

function formatExpectedStatus(expected: ExpectedHttpStatus | undefined): string {
  if (expected === undefined) return "2xx";
  return Array.isArray(expected) ? expected.map(String).join(", ") : String(expected);
}

function durationMs(report: BachsProofReport): number {
  if (!report.completedAt) return 0;
  return Math.max(0, Date.parse(report.completedAt) - Date.parse(report.startedAt));
}

function financialDiscrepancies(expected: ExpectedPaymentState, observed: ObservedPaymentState | undefined): string[] {
  if (!observed) return [];
  const discrepancies: string[] = [];
  if (observed.creditCount !== expected.expectedCreditCount) {
    discrepancies.push(`credit count: expected ${expected.expectedCreditCount}, observed ${observed.creditCount}`);
  }
  if (observed.creditedAmountMinor !== expected.amountMinor) {
    discrepancies.push(`credited amount: expected ${exactAmount(expected.amountMinor, expected.currency)}, observed ${exactAmount(observed.creditedAmountMinor, observed.currency)}`);
  }
  if (observed.currency !== expected.currency) {
    discrepancies.push(`currency: expected ${expected.currency}, observed ${observed.currency}`);
  }
  return discrepancies;
}

function paymentEvidenceLines(report: BachsProofReport): string[] {
  if (report.failureType === "payment-preparation") {
    return [
      "  Expected: unavailable (payment was not prepared)",
      "  Observed: unavailable (financial verification did not run)"
    ];
  }
  if (!report.payments || report.payments.length === 0) {
    return [
      `  Expected: ${expectedDescription(report.expected)}`,
      `  Observed: ${observedDescription(report.observed)}`
    ];
  }
  const lines: string[] = [];
  for (const [index, payment] of report.payments.entries()) {
    lines.push(`  Payment ${index + 1}: ${payment.event.reference}`);
    lines.push(`    Expected: ${expectedDescription(payment.expected)}`);
    lines.push(`    Observed: ${observedDescription(payment.observed)}`);
  }
  return lines;
}

function invariantViolations(report: BachsProofReport): InvariantViolation[] {
  return report.verification?.violations ?? [];
}

function redactLines(lines: string[], redact: (value: string) => string): string[] {
  return lines.map(redact);
}

function scenarioDetail(run: BachsProofCliRun, enabled: boolean, redact: (value: string) => string): string[] {
  const { name, result } = run;
  const report = result.report;
  const lines: string[] = [
    `${statusLabel(result, enabled)}  ${name}`,
    `  Scenario: ${report.scenario}`,
    `  Payment reference: ${report.paymentReference}`,
    `  Webhook deliveries:`
  ];

  if (report.deliveries.length === 0) {
    lines.push(`    ${report.failureType === "payment-preparation" ? "none (payment was not prepared)" : "none"}`);
  } else {
    for (const delivery of report.deliveries) {
      const event = delivery.eventType ? ` ${delivery.eventType}` : "";
      const id = delivery.eventId ? ` (${delivery.eventId})` : "";
      lines.push(`    ${deliveryStatus(delivery, enabled)}${event}${id}`);
      lines.push(`      Expected: HTTP ${formatExpectedStatus(delivery.expectedStatus)}`);
      if (delivery.error) lines.push(`      ${redact(delivery.error)}`);
      if (delivery.responseBody && recordedDeliveryOutcome(delivery) !== "passed") {
        lines.push(`      Response body: ${redact(responseBodyText(delivery.responseBody))}`);
      }
    }
  }

  lines.push(`  Financial correctness: ${financialOutcomeText(report, enabled)}`);
  lines.push(...paymentEvidenceLines(report));

  const discrepancies = report.payments?.flatMap((payment, index) => financialDiscrepancies(payment.expected, payment.observed)
    .map((value) => `payment ${index + 1}: ${value}`)) ?? financialDiscrepancies(report.expected, report.observed);
  if (discrepancies.length > 0) {
    lines.push(`  Financial discrepancies:`);
    lines.push(...discrepancies.map((value) => `    - ${value}`));
  }

  const violations = invariantViolations(report);
  if (violations.length > 0) {
    lines.push(`  Financial invariant violations:`);
    lines.push(...violations.map((violation) => `    - ${violation.id} ${violation.name}: ${violation.message}`));
  }

  const failure = failureLabel(report);
  if (failure) {
    lines.push(`  Failure type: ${color(failure, ANSI.red, enabled)}`);
  }
  if (report.errors.length > 0) {
    lines.push(`  Explanation:`);
    lines.push(...redactLines(report.errors, redact).map((error) => `    - ${error}`));
  }
  lines.push(`  Duration: ${durationMs(report)}ms`);
  return lines;
}

function compactScenarioLine(run: BachsProofCliRun, enabled: boolean): string {
  const outcomes = [...new Set(run.result.report.deliveries.map((record) => recordedDeliveryOutcome(record)))];
  const deliveryText = outcomes.length === 0
    ? "NONE"
    : outcomes.map((outcome) => {
      const label = deliveryOutcomeLabel(outcome);
      return color(label.text, label.color, enabled);
    }).join("/");
  return `${statusLabel(run.result, enabled)}  ${run.name}  Delivery: ${deliveryText}  Financial: ${financialOutcomeText(run.result.report, enabled)}  ${durationMs(run.result.report)}ms`;
}

/** Render CLI results for people; JSON mode continues to use the raw result objects. */
export function formatHumanReadableReport(
  results: BachsProofCliRun[],
  summary: BachsProofSummary,
  options: HumanReadableReportOptions = {}
): string {
  const enabled = options.useColor ?? shouldUseColor();
  const redact = options.redact ?? ((value: string) => value);
  const lines: string[] = [color(`BachsProof v${BACHS_PROOF_VERSION}`, ANSI.cyan, enabled)];

  if (results.length === 1) {
    lines.push("", ...scenarioDetail(results[0]!, enabled, redact));
  } else {
    lines.push("", "Scenario summary");
    lines.push(...results.map((run) => `  ${compactScenarioLine(run, enabled)}`));
    const failures = results.filter((run) => !run.result.passed);
    if (failures.length > 0) {
      lines.push("", "Failure details");
      for (const failure of failures) lines.push("", ...scenarioDetail(failure, enabled, redact));
    }
  }

  lines.push(
    "",
    "Final summary",
    `  ${summary.total} scenario(s): ${summary.passed} passed, ${summary.failed} failed`,
    `  Financial correctness: ${results.filter((run) => financialOutcome(run.result.report) === "PASS").length} PASS, ${results.filter((run) => financialOutcome(run.result.report) === "FAIL").length} FAIL, ${results.filter((run) => financialOutcome(run.result.report) === "UNVERIFIED").length} UNVERIFIED`,
    `  Financial invariant violations: ${summary.financialViolations}`,
    `  Duration: ${summary.durationMs}ms`
  );
  return `${lines.join("\n")}\n`;
}
