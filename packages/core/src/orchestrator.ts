import { randomUUID } from "node:crypto";
import { fetch } from "undici";
import { verifyPaymentState } from "./invariants.js";
import { preparePaymentReferences } from "./preparation.js";
import { verifyWithCallback } from "./verification.js";
import type {
  BachsProofOptions,
  BachsProofReport,
  BachsProofResult,
  DeliveryRecord,
  ExpectedHttpStatus,
  FinancialVerificationContext,
  ObservedPaymentState,
  PaymentEvent,
  ProviderScenario,
  ProviderScenarioDelivery,
  RunOptions,
  ScenarioName
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
const DEFAULT_NEGATIVE_OBSERVATION_MS = 250;

function eventId(event: PaymentEvent): string | undefined {
  for (const key of ["id", "eventId", "providerEventId"]) {
    const value = event[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function eventType(event: PaymentEvent): string | undefined {
  return typeof event.type === "string" ? event.type : undefined;
}

function matchesExpectedStatus(status: number, expected: ExpectedHttpStatus): boolean {
  if (Array.isArray(expected)) return expected.some((candidate) => matchesExpectedStatus(status, candidate));
  if (expected === "2xx") return status >= 200 && status < 300;
  if (expected === "4xx") return status >= 400 && status < 500;
  if (expected === "5xx") return status >= 500 && status < 600;
  return status === expected;
}

function formatExpectedStatus(expected: ExpectedHttpStatus): string {
  return Array.isArray(expected) ? expected.map(String).join(", ") : String(expected);
}

function deliveryOutcome(status: number, accepted: boolean, expectedStatus: ExpectedHttpStatus | undefined): import("./types.js").DeliveryOutcome {
  if (status === 401 || status === 403) return "authentication-failure";
  if (status === 429) return "rate-limit-failure";
  if (status >= 500 && status < 600) return "infrastructure-failure";
  if (accepted && expectedStatus !== undefined && status >= 400 && status < 500) return "expected-rejection";
  if (accepted) return "passed";
  return "unexpected-http-response";
}

function validateRunOptions(input: RunOptions): string | undefined {
  if (input.concurrency !== undefined && (!Number.isInteger(input.concurrency) || input.concurrency < 1)) {
    return "concurrency must be a positive integer";
  }
  if (input.amountMinor !== undefined && (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0)) {
    return "amountMinor must be a non-negative safe integer in minor units";
  }
  if (input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency)) {
    return "currency must be a three-letter ISO currency code";
  }
  return undefined;
}

function verificationComplete(expected: import("./types.js").ExpectedPaymentState, state: ObservedPaymentState, negativeDeadline: number): boolean {
  if (state.pending) return false;
  if (expected.eligible) return state.creditCount > 0;
  return state.creditCount > 0 || Date.now() >= negativeDeadline;
}

function failureTypeFor(error: unknown): "financial-verification" | "financial-verification-timeout" {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("timed out") ? "financial-verification-timeout" : "financial-verification";
}

/**
 * High-level v2 runner. It prepares real application payments, sends signed
 * local events, and always evaluates committed financial state before passing.
 */
export class BachsProof<TEvent extends PaymentEvent = PaymentEvent> {
  constructor(private readonly options: BachsProofOptions<TEvent>) {
    if (!options.createPayment) throw new Error("BachsProof requires a createPayment callback");
    if (!options.verify) throw new Error("BachsProof requires a verify callback");
    try {
      const url = new URL(options.webhookUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("webhookUrl must use http or https");
    } catch (error) {
      throw new Error(`BachsProof requires a complete webhookUrl: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async run(input: RunOptions): Promise<BachsProofResult> {
    const requestedInput = input;
    const validationError = validateRunOptions(input);
    if (validationError) return this.invalidInputResult(input, validationError);

    const startedAt = new Date().toISOString();
    const amountMinor = input.amountMinor ?? 500_000;
    const currency = input.currency ?? "NGN";
    const concurrency = input.concurrency ?? (input.scenario === "concurrent-duplicate-credit" || input.scenario === "concurrent-unique-payments" ? 2 : 1);

    let references: string[];
    try {
      references = await preparePaymentReferences({ ...input, amountMinor, currency }, this.options.createPayment);
    } catch (error) {
      return this.invalidInputResult(requestedInput, error instanceof Error ? error.message : String(error), "payment-preparation");
    }

    let primaryEvent: TEvent;
    let scenarioPlan: ProviderScenario<TEvent> | undefined;
    let scenarioEvents: TEvent[];
    let verificationCases: Array<{ event: TEvent; expected: import("./types.js").ExpectedPaymentState }>;
    try {
      const baseEvent = this.options.provider.createPayment({
        reference: references[0]!,
        amountMinor,
        currency
      });
      const providerInput = {
        ...input,
        amountMinor,
        currency,
        concurrency,
        reference: references[0]!,
        references
      };
      scenarioPlan = this.options.provider.createScenario?.(input.scenario, providerInput);
      primaryEvent = scenarioPlan?.deliveries.find((delivery) => delivery.event)?.event ?? baseEvent;
      verificationCases = scenarioPlan?.verification?.map((item) => ({
        event: item.event,
        expected: item.expected ?? this.options.provider.expectedState(item.event)
      })) ?? [{ event: primaryEvent, expected: this.options.provider.expectedState(primaryEvent) }];
      scenarioEvents = Array.from(new Set([
        primaryEvent,
        ...(scenarioPlan?.deliveries.map((delivery) => delivery.event).filter((event): event is TEvent => Boolean(event)) ?? []),
        ...(scenarioPlan?.verification?.map((item) => item.event) ?? [])
      ]));

      if (input.scenario === "concurrent-unique-payments") {
        const uniqueEvents = references.map((reference) => this.options.provider.createPayment({ reference, amountMinor, currency }));
        primaryEvent = uniqueEvents[0]!;
        scenarioEvents = uniqueEvents;
        verificationCases = uniqueEvents.map((event) => ({ event, expected: this.options.provider.expectedState(event) }));
      }
    } catch (error) {
      return this.invalidInputResult(input, `Payment preparation failed for ${input.scenario}: ${error instanceof Error ? error.message : String(error)}`, "payment-preparation");
    }

    const expected = verificationCases[0]?.expected ?? this.options.provider.expectedState(primaryEvent);
    const report: BachsProofReport = {
      reportVersion: "2.0",
      scenario: input.scenario,
      provider: this.options.provider.name,
      paymentReference: primaryEvent.reference,
      event: primaryEvent,
      expected,
      financiallyVerified: false,
      financialOutcome: "UNVERIFIED",
      deliveries: [],
      errors: [],
      startedAt
    };

    try {
      if (scenarioPlan) {
        await this.runScenarioPlan(scenarioPlan, primaryEvent, report);
      } else if (input.scenario === "concurrent-duplicate-credit") {
        const participants = Array.from({ length: concurrency }, (_, index) => `participant-${index + 1}`);
        await Promise.all(participants.map((participant) => this.deliver(primaryEvent, participant, report, {
          expectedStatus: ["2xx", 400, 409, 422]
        })));
      } else if (input.scenario === "sequential-duplicate-webhook") {
        await this.deliver(primaryEvent, "sequential-1", report, { expectedStatus: "2xx" });
        await this.deliver(primaryEvent, "sequential-2", report, { expectedStatus: ["2xx", 400, 409, 422] });
      } else if (input.scenario === "concurrent-unique-payments") {
        await Promise.all(scenarioEvents.map((event) => this.deliver(event, `unique-${event.reference}`, report, { expectedStatus: "2xx" })));
      } else {
        report.errors.push(`Unsupported scenario ${input.scenario}`);
        report.failureType = "webhook-delivery";
      }

      await this.verifyPayments(input.scenario, scenarioEvents, verificationCases, report);
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
      report.failureType ??= "webhook-delivery";
    } finally {
      report.completedAt = new Date().toISOString();
    }

    return {
      passed: report.errors.length === 0 && report.financiallyVerified && report.verification?.passed === true,
      report
    };
  }

  private async runScenarioPlan(plan: ProviderScenario<TEvent>, primaryEvent: TEvent, report: BachsProofReport): Promise<void> {
    if (plan.concurrent) {
      await Promise.all(plan.deliveries.map((delivery, index) => this.deliver(
        delivery.event ?? primaryEvent,
        delivery.participantId ?? `scenario-${index + 1}`,
        report,
        delivery
      )));
      return;
    }
    for (const [index, delivery] of plan.deliveries.entries()) {
      await this.deliver(
        delivery.event ?? primaryEvent,
        delivery.participantId ?? `scenario-${index + 1}`,
        report,
        delivery
      );
    }
  }

  private async deliver(
    event: TEvent,
    participantId: string,
    report: BachsProofReport,
    scenarioDelivery: ProviderScenarioDelivery<TEvent> = {}
  ): Promise<void> {
    const delivery: DeliveryRecord = {
      deliveryId: randomUUID(),
      participantId,
      reference: event.reference,
      eventId: eventId(event),
      eventType: eventType(event),
      startedAt: new Date().toISOString(),
      expectedStatus: scenarioDelivery.expectedStatus
    };
    try {
      if (scenarioDelivery.delayMs && scenarioDelivery.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, scenarioDelivery.delayMs));
      }
      const body = this.options.provider.serialize(event);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(this.options.provider.headersForBody?.(event, body) ?? this.options.provider.headers?.(event) ?? {})
      };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_DELIVERY_TIMEOUT_MS);
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(this.options.webhookUrl, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
      delivery.status = response.status;
      delivery.responseBody = await response.text();
      const expectedStatus = scenarioDelivery.expectedStatus;
      const expectedByScenario = expectedStatus === undefined ? response.ok : matchesExpectedStatus(response.status, expectedStatus);
      // These statuses must remain failures even if a provider adapter uses a
      // broad status-family expectation. Rejections are opt-in per delivery.
      const forcedFailure = response.status < 200
        || (response.status >= 300 && response.status < 400)
        || response.status === 401
        || response.status === 403
        || response.status === 429
        || (response.status >= 500 && response.status < 600);
      const accepted = forcedFailure ? false : expectedByScenario;
      delivery.deliveryOutcome = deliveryOutcome(response.status, accepted, expectedStatus);
      if (!accepted) {
        const expectedText = expectedStatus === undefined ? "a successful HTTP response" : `HTTP ${formatExpectedStatus(expectedStatus)}`;
        delivery.error = `Webhook delivery ${participantId} expected ${expectedText} but received HTTP ${response.status}`;
        report.errors.push(delivery.error);
        report.failureType ??= "unexpected-http-response";
      }
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError";
      delivery.error = isTimeout
        ? `request timed out after ${DEFAULT_DELIVERY_TIMEOUT_MS}ms`
        : error instanceof Error ? error.message : String(error);
      delivery.deliveryOutcome = "network-failure";
      report.errors.push(`Webhook delivery ${participantId} failed: ${delivery.error}`);
      report.failureType ??= "webhook-delivery";
    } finally {
      delivery.completedAt = new Date().toISOString();
      report.deliveries.push(delivery);
    }
  }

  private async verifyPayments(
    scenario: ScenarioName,
    scenarioEvents: TEvent[],
    verificationCases: Array<{ event: TEvent; expected: import("./types.js").ExpectedPaymentState }>,
    report: BachsProofReport
  ): Promise<void> {
    const results: Array<{
      event: TEvent;
      expected: import("./types.js").ExpectedPaymentState;
      observed: ObservedPaymentState;
      verification: import("./types.js").VerificationResult;
    }> = [];
    for (const { event, expected } of verificationCases) {
      const relatedEvents = scenarioEvents.filter((candidate) => candidate.reference === event.reference);
      const context: FinancialVerificationContext = {
        scenario,
        paymentReference: event.reference,
        expected,
        expectedOutcome: {
          eligible: expected.eligible,
          expectedCreditCount: expected.expectedCreditCount,
          amountMinor: expected.amountMinor,
          currency: expected.currency
        },
        events: relatedEvents,
        eventIdentifiers: relatedEvents.map(eventId).filter((value): value is string => Boolean(value)),
        deliveries: report.deliveries.filter((delivery) => delivery.reference === event.reference)
      };
      try {
        const observed = await this.inspect(event.reference, expected, context);
        results.push({ event, expected, observed, verification: verifyPaymentState(expected, observed) });
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error));
        report.failureType ??= failureTypeFor(error);
      }
    }

    if (results.length !== verificationCases.length) return;
    report.financiallyVerified = true;
    report.observed = results[0]?.observed;
    report.verification = {
      passed: results.every((result) => result.verification.passed),
      violations: results.flatMap((result) => result.verification.violations)
    };
    report.financialOutcome = report.verification.passed ? "PASS" : "FAIL";
    if (results.length > 1) report.payments = results;
    if (!report.verification.passed) {
      report.failureType ??= "invariant-violation";
      report.errors.push(...report.verification.violations.map((violation) => `${violation.id}: ${violation.message}`));
    }
  }

  private async inspect(reference: string, expected: import("./types.js").ExpectedPaymentState, context: FinancialVerificationContext): Promise<ObservedPaymentState> {
    const settings = this.options.financialVerification;
    const timeoutMs = settings?.completionDeadlineMs ?? DEFAULT_TIMEOUT_MS;
    const negativeDeadline = Date.now() + (expected.eligible ? 0 : settings?.negativeObservationWindowMs ?? DEFAULT_NEGATIVE_OBSERVATION_MS);
    return verifyWithCallback(this.options.verify, reference, timeoutMs, context, {
      pollIntervalMs: settings?.pollIntervalMs,
      isComplete: (state) => verificationComplete(expected, state, negativeDeadline)
    });
  }

  private invalidInputResult(input: RunOptions, message: string, failureType: "payment-preparation" | "webhook-delivery" = "webhook-delivery"): BachsProofResult {
    const startedAt = new Date().toISOString();
    const reference = "<payment-not-prepared>";
    const event: PaymentEvent = {
      reference,
      amountMinor: input.amountMinor ?? 0,
      currency: input.currency ?? "NGN",
      status: "NOT_PREPARED"
    };
    const report: BachsProofReport = {
      reportVersion: "2.0",
      scenario: input.scenario,
      provider: this.options.provider.name,
      paymentReference: reference,
      event,
      expected: { reference, eligible: false, amountMinor: event.amountMinor, currency: event.currency, expectedCreditCount: 0 },
      financiallyVerified: false,
      financialOutcome: "UNVERIFIED",
      deliveries: [],
      errors: [message],
      failureType,
      startedAt,
      completedAt: new Date().toISOString()
    };
    return { passed: false, report };
  }
}
