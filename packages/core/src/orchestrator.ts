import { randomUUID } from "node:crypto";
import { fetch } from "undici";
import { RaceController } from "./race-controller.js";
import { verifyPaymentState } from "./invariants.js";
import { preparePaymentReferences } from "./preparation.js";
import { normalizeCallbackState, verifyWithCallback } from "./verification.js";
import type {
  DeliveryRecord,
  FinancialVerificationContext,
  ObservedPaymentState,
  PayProofOptions,
  PayProofReport,
  PayProofResult,
  PaymentEvent,
  ProviderScenario,
  ProviderScenarioDelivery,
  RunOptions
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_NEGATIVE_OBSERVATION_MS = 250;

function validateRunOptions(input: RunOptions, canPreparePayment = false): string | undefined {
  if (input.concurrency !== undefined && (!Number.isInteger(input.concurrency) || input.concurrency < 1)) {
    return "concurrency must be a positive integer";
  }
  if (input.scenario === "concurrent-unique-payments") {
    if (input.reference !== undefined && input.references !== undefined) return "concurrent-unique-payments accepts references, not both reference and references";
    if (input.references !== undefined) {
      if (input.references.length < 2) return "concurrent-unique-payments requires at least two distinct references";
      if (input.references.some((reference) => typeof reference !== "string" || reference.trim().length === 0)) return "all payment references must be non-empty strings";
      if (new Set(input.references).size !== input.references.length) return "payment references must be distinct for concurrent-unique-payments";
      if (input.concurrency !== undefined && input.references.length !== input.concurrency) return "concurrency must match the number of supplied payment references";
    } else if (!input.syntheticReferences && !canPreparePayment && !input.replay?.event?.reference) {
      return "real application references are required; provide references or explicitly set syntheticReferences: true";
    }
  } else {
    if (input.references !== undefined) return `${input.scenario} accepts one reference; use references only with concurrent-unique-payments`;
    const replayReference = input.replay?.event?.reference;
    if (input.reference !== undefined && (typeof input.reference !== "string" || input.reference.trim().length === 0)) {
      return `reference must be a non-empty string for ${input.scenario}`;
    }
    if ((!input.reference || input.reference.trim().length === 0) && (!replayReference || replayReference.trim().length === 0) && !input.syntheticReferences && !canPreparePayment) {
      return `real application reference is required for ${input.scenario}; explicitly set syntheticReferences: true to use generated fixtures`;
    }
  }
  return undefined;
}

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

function observedStateComplete(expected: import("./types.js").ExpectedPaymentState, state: ObservedPaymentState, negativeDeadline: number): boolean {
  if (state.pending) return false;
  const verification = verifyPaymentState(expected, state);
  if (expected.eligible) return verification.passed;
  if (state.creditCount > 0) return true;
  return Date.now() >= negativeDeadline;
}

function matchesExpectedStatus(status: number, expected: import("./types.js").ExpectedHttpStatus): boolean {
  if (Array.isArray(expected)) return expected.includes(status);
  if (expected === "2xx") return status >= 200 && status < 300;
  if (expected === "4xx") return status >= 400 && status < 500;
  if (expected === "5xx") return status >= 500 && status < 600;
  return status === expected;
}

function formatExpectedStatus(expected: import("./types.js").ExpectedHttpStatus): string {
  return Array.isArray(expected) ? expected.join(", ") : String(expected);
}

/**
 * High-level PayProof runner. It owns only test orchestration; the application
 * remains responsible for webhook authentication and business persistence.
 */
export class PayProof<TEvent extends PaymentEvent = PaymentEvent> {
  /** Store the immutable configuration used by every run and replay. */
  constructor(private readonly options: PayProofOptions<TEvent>) {}

  async run(input: RunOptions): Promise<PayProofResult> {
    const requestedInput = input;
    const validationError = validateRunOptions(input, Boolean(this.options.createPayment));
    if (validationError) return this.invalidInputResult(input, validationError);
    try {
      input = await preparePaymentReferences(input, this.options.createPayment);
    } catch (error) {
      return this.invalidInputResult(requestedInput, error instanceof Error ? error.message : String(error));
    }
    const preparedValidationError = validateRunOptions(input);
    if (preparedValidationError) return this.invalidInputResult(input, preparedValidationError);
    // A run creates one logical event and then chooses a delivery schedule.
    // Replay replaces event generation with the serialized event from a report.
    const startedAt = new Date().toISOString();
    const concurrency = Math.max(1, input.references?.length ?? input.concurrency ?? (input.scenario === "concurrent-duplicate-credit" || input.scenario === "concurrent-unique-payments" ? 2 : 1));
    const seed = input.seed ?? input.replay?.replay.seed ?? randomUUID();
    let generatedEvent: TEvent;
    let scenarioPlan: ProviderScenario<TEvent> | undefined;
    try {
      generatedEvent = (input.replay?.event as TEvent | undefined) ?? this.options.provider.createPayment({
        reference: input.reference ?? input.references?.[0],
        amountMinor: input.amountMinor,
        currency: input.currency,
        syntheticReferences: input.syntheticReferences
      });
      scenarioPlan = input.replay ? undefined : this.options.provider.createScenario?.(input.scenario, input);
    } catch (error) {
      return this.invalidInputResult(input, `Payment preparation failed for ${input.scenario}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const event = scenarioPlan?.deliveries.find((delivery) => delivery.event)?.event ?? generatedEvent;
    const verificationCases = scenarioPlan?.verification?.map((item) => ({
      event: item.event,
      expected: item.expected ?? this.options.provider.expectedState(item.event)
    })) ?? [{ event, expected: this.options.provider.expectedState(event) }];
    const expected = verificationCases[0]?.expected ?? this.options.provider.expectedState(event);
    let scenarioEvents: TEvent[] = Array.from(new Set([
      event,
      ...(scenarioPlan?.deliveries.map((delivery) => delivery.event).filter((candidate): candidate is TEvent => Boolean(candidate)) ?? []),
      ...(scenarioPlan?.verification?.map((item) => item.event) ?? [])
    ]));
    const checkpoint = input.scenario === "concurrent-duplicate-credit" ? this.options.checkpoint?.name : undefined;
    let eventsForVerification = verificationCases;
    // The report is initialized before network work so preparation/controller
    // failures produce a useful artifact.
    const report: PayProofReport = {
      reportVersion: "1.1",
      scenario: input.scenario,
      provider: this.options.provider.name,
      mode: this.options.provider.mode,
      paymentReference: event.reference,
      event,
      expected,
      verificationMode: this.options.verify ? "callback" : "none",
      financiallyVerified: false,
      deliveries: [],
      checkpoints: [],
      errors: [],
      replay: {
        seed,
        concurrency,
        checkpoint,
        controlled: checkpoint !== undefined,
        note: "Replay controls explicitly instrumented checkpoints when configured; it does not claim deterministic OS, network, or database scheduling."
      },
      startedAt
    };

    let controller: RaceController | undefined;
    let sessionId: string | undefined;
    try {
      if (scenarioPlan) {
        await this.runScenarioPlan(scenarioPlan, event, report);
      } else if (checkpoint) {
        // Controlled-concurrency mode registers every participant before any
        // webhook is sent, removing dependence on random request timing.
        controller = new RaceController();
        const participants = Array.from({ length: concurrency }, (_, index) => `participant-${index + 1}`);
        const session = await controller.registerSession({ participants });
        sessionId = session.id;
        const deliveries = participants.map((participantId) => this.deliver(event, participantId, session, report));
        try {
          await controller.waitForArrivals(session.id, checkpoint, concurrency, this.options.checkpoint?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
          controller.release(session.id, checkpoint);
        } catch (error) {
          report.errors.push(error instanceof Error ? error.message : String(error));
          controller.abort(session.id, "arrival-timeout");
        }
        await this.settleConcurrentDeliveries(deliveries, report);
        report.checkpoints = controller.getTrace(session.id);
      } else if (input.scenario === "concurrent-duplicate-credit") {
        const participants = Array.from({ length: concurrency }, (_, index) => `participant-${index + 1}`);
        await this.settleConcurrentDeliveries(participants.map((participantId) => this.deliver(event, participantId, undefined, report)), report);
      } else if (input.scenario === "sequential-duplicate-webhook") {
        // Sequential mode intentionally leaves the checkpoint disabled; it
        // verifies ordinary idempotency without a race barrier.
        await this.deliver(event, "sequential-1", undefined, report);
        await this.deliver(event, "sequential-2", undefined, report);
      } else if (input.scenario === "concurrent-unique-payments") {
        // Unique events share a delivery wave but use distinct references, so
        // the verifier can validate each payment individually.
        const references = input.references ?? Array.from({ length: concurrency }, (_, index) => `${event.reference}-${index + 1}`);
        if (references.length !== concurrency) throw new Error("references must contain exactly one entry per concurrent unique payment");
        const events = references.map((reference) => this.options.provider.createPayment({
          amountMinor: input.amountMinor,
          currency: input.currency,
          reference,
          syntheticReferences: input.syntheticReferences
        }));
        await this.settleConcurrentDeliveries(events.map((uniqueEvent) => this.deliver(uniqueEvent, `unique-${uniqueEvent.reference}`, undefined, report)), report);
        eventsForVerification = events.map((uniqueEvent) => ({
          event: uniqueEvent,
          expected: this.options.provider.expectedState(uniqueEvent)
        }));
        scenarioEvents = events;
      } else {
        report.errors.push(`Unsupported scenario ${input.scenario}`);
      }

      // Level 1 intentionally stops after delivery. It is useful for webhook
      // contract testing, but it cannot prove that money was persisted safely.
      if (!this.options.verify) {
        report.financiallyVerified = false;
      } else {
        // Inspect each reference separately. Aggregate balance checks alone
        // could miss one over-credit and one under-credit cancelling out.
        const paymentResults = await Promise.all(eventsForVerification.map(async ({ event: paymentEvent, expected: paymentExpected }) => {
          const relatedEvents = scenarioEvents.filter((scenarioEvent) => scenarioEvent.reference === paymentEvent.reference);
          const context: FinancialVerificationContext = {
            scenario: input.scenario,
            paymentReference: paymentEvent.reference,
            expected: paymentExpected,
            expectedOutcome: {
              eligible: paymentExpected.eligible,
              expectedCreditCount: paymentExpected.expectedCreditCount,
              amountMinor: paymentExpected.amountMinor,
              currency: paymentExpected.currency
            },
            events: relatedEvents,
            eventIdentifiers: relatedEvents.map(eventId).filter((identifier): identifier is string => Boolean(identifier)),
            deliveries: report.deliveries.filter((delivery) => delivery.reference === paymentEvent.reference)
          };
          const paymentObserved = await this.inspect(paymentEvent.reference, paymentExpected, context);
          return {
            event: paymentEvent,
            expected: paymentExpected,
            observed: paymentObserved,
            verification: verifyPaymentState(paymentExpected, paymentObserved)
          };
        }));
        report.financiallyVerified = true;
        report.observed = paymentResults[0]?.observed;
        report.verification = {
          passed: paymentResults.every((payment) => payment.verification.passed),
          violations: paymentResults.flatMap((payment) => payment.verification.violations)
        };
        if (paymentResults.length > 1) report.payments = paymentResults;
        if (!report.verification.passed) {
          report.errors.push(...report.verification.violations.map((violation) => `${violation.id}: ${violation.message}`));
        }
      }
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      if (controller && sessionId) {
        report.checkpoints = controller.getTrace(sessionId);
        controller.cleanupSession(sessionId);
      }
      if (controller) await controller.close();
      report.completedAt = new Date().toISOString();
    }
    const financialPass = !report.financiallyVerified || report.verification?.passed === true;
    return { passed: report.errors.length === 0 && financialPass, report };
  }

  async replay(report: PayProofReport): Promise<PayProofResult> {
    // Application-owned preparation/isolation is delegated to the caller;
    // replay only supplies the prior event and schedule metadata.
    return this.run({
      scenario: report.scenario,
      concurrency: report.replay.concurrency,
      seed: report.replay.seed,
      replay: report
    });
  }

  private invalidInputResult(input: RunOptions, message: string): PayProofResult {
    const startedAt = new Date().toISOString();
    const reference = input.reference ?? input.references?.[0] ?? "<missing-reference>";
    const event: PaymentEvent = {
      reference,
      amountMinor: input.amountMinor ?? 0,
      currency: input.currency ?? "NGN",
      status: "INVALID_INPUT"
    };
    const report: PayProofReport = {
      reportVersion: "1.1",
      scenario: input.scenario,
      provider: this.options.provider.name,
      mode: this.options.provider.mode,
      paymentReference: reference,
      event,
      expected: { reference, eligible: false, amountMinor: event.amountMinor, currency: event.currency, expectedCreditCount: 0 },
      verificationMode: this.options.verify ? "callback" : "none",
      financiallyVerified: false,
      deliveries: [],
      checkpoints: [],
      errors: [message],
      replay: {
        seed: input.seed ?? randomUUID(),
        concurrency: input.concurrency ?? 1,
        controlled: false,
        note: "No webhook was sent because payment preparation or run configuration validation failed."
      },
      startedAt,
      completedAt: new Date().toISOString()
    };
    return { passed: false, report };
  }

  private async runScenarioPlan(
    plan: ProviderScenario<TEvent>,
    primaryEvent: TEvent,
    report: PayProofReport
  ): Promise<void> {
    if (plan.concurrent) {
      await this.settleConcurrentDeliveries(plan.deliveries.map((delivery, index) => this.deliver(
        delivery.event ?? primaryEvent,
        delivery.participantId ?? `scenario-${index + 1}`,
        undefined,
        report,
        delivery
      )), report);
      return;
    }
    for (const [index, delivery] of plan.deliveries.entries()) {
      try {
        await this.deliver(
          delivery.event ?? primaryEvent,
          delivery.participantId ?? `scenario-${index + 1}`,
          undefined,
          report,
          delivery
        );
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async settleConcurrentDeliveries(deliveries: Promise<void>[], report: PayProofReport): Promise<void> {
    const settled = await Promise.allSettled(deliveries);
    for (const result of settled) {
      if (result.status === "rejected") {
        report.errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }
  }

  private async deliver(
    event: TEvent,
    participantId: string,
    session: { id: string; token: string; controllerUrl: string } | undefined,
    report: PayProofReport,
    scenarioDelivery: ProviderScenarioDelivery<TEvent> = {}
  ): Promise<void> {
    // Delivery records are created before fetch so connection errors still have
    // a participant, start time, and eventual error entry in the report.
    const delivery: DeliveryRecord = {
      deliveryId: randomUUID(),
      participantId,
      reference: event.reference,
      startedAt: new Date().toISOString(),
      eventId: eventId(event),
      eventType: eventType(event),
      expectedStatus: scenarioDelivery.expectedStatus
    };
    const body = scenarioDelivery.body ?? this.options.provider.serialize(event);
    const signingBody = scenarioDelivery.signingBody ?? body;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.options.target.headers,
      ...(this.options.provider.headersForBody?.(event, signingBody) ?? this.options.provider.headers?.(event) ?? {}),
      ...scenarioDelivery.headers
    };
    if (session) {
      headers["x-payproof-enabled"] = "true";
      headers["x-payproof-controller"] = session.controllerUrl;
      headers["x-payproof-session"] = session.id;
      headers["x-payproof-participant"] = participantId;
      headers["x-payproof-token"] = session.token;
    }
    try {
      if (scenarioDelivery.delayMs && scenarioDelivery.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, scenarioDelivery.delayMs));
      }
      const response = await fetch(this.url(this.options.target.webhookPath), {
        method: "POST",
        headers,
        body
      });
      delivery.status = response.status;
      delivery.responseBody = await response.text();
      if (scenarioDelivery.expectedStatus !== undefined) {
        if (!matchesExpectedStatus(response.status, scenarioDelivery.expectedStatus)) {
          throw new Error(`Webhook delivery ${participantId} expected HTTP ${formatExpectedStatus(scenarioDelivery.expectedStatus)} but received HTTP ${response.status}: ${delivery.responseBody}`);
        }
      } else if (!response.ok) {
        throw new Error(`Webhook delivery ${participantId} failed with HTTP ${response.status}: ${delivery.responseBody}`);
      }
    } catch (error) {
      delivery.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      delivery.completedAt = new Date().toISOString();
      // Delivery records are appended after each request so reports retain failures.
      report.deliveries.push(delivery);
    }
  }

  private async inspect(reference: string, expected: import("./types.js").ExpectedPaymentState, context: FinancialVerificationContext): Promise<ObservedPaymentState> {
    const financialVerification = this.options.financialVerification;
    const completionDeadlineMs = financialVerification?.completionDeadlineMs ?? DEFAULT_TIMEOUT_MS;
    const negativeDeadline = Date.now() + (expected.eligible ? 0 : financialVerification?.negativeObservationWindowMs ?? DEFAULT_NEGATIVE_OBSERVATION_MS);
    const isComplete = (state: ObservedPaymentState) => observedStateComplete(expected, state, negativeDeadline);
    if (!this.options.verify) throw new Error("Financial verification was requested without a verify callback");
    return verifyWithCallback(this.options.verify, reference, completionDeadlineMs, context, {
      pollIntervalMs: financialVerification?.pollIntervalMs,
      isComplete
    });
  }

  private url(path: string): string {
    return new URL(path, this.options.target.baseUrl).toString();
  }
}
