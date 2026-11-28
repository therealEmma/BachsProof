import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExpectedPaymentState, PaymentEvent, ProviderScenario, ProviderScenarioInput, ScenarioName } from "@bachsproof/core";
import { formatBachsMoney, parseBachsMoney, safeNumberMoney, toBachsMinorUnits } from "./money.js";

const customerSchema = z.object({
  id: z.string().min(1).nullable().optional(),
  customer_id: z.string().min(1).nullable().optional(),
  email: z.string().email().nullable().optional(),
  name: z.string().nullable().optional()
}).passthrough();

const checkoutDataSchema = z.object({
  checkout_id: z.string().min(1),
  status: z.string().min(1),
  mode: z.string().min(1),
  payment_status: z.string().nullable(),
  amount: z.string().min(1),
  currency: z.string().length(3).nullable(),
  reference: z.string().min(1).nullable(),
  customer: customerSchema.nullable(),
  charge: z.object({ id: z.string().min(1) }).passthrough().nullable(),
  metadata: z.record(z.unknown()).default({})
}).passthrough();

const collectionDataSchema = z.object({
  charge_id: z.string().min(1).nullable(),
  checkout_id: z.string().min(1).nullable(),
  reference: z.string().min(1).nullable(),
  status: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().length(3),
  customer: customerSchema,
  metadata: z.record(z.unknown()).default({})
}).passthrough();

const underpaidDataSchema = z.object({
  charge_id: z.string().min(1),
  reference: z.string().min(1).nullable(),
  checkout_id: z.string().min(1).nullable(),
  amount_paid: z.string().min(1),
  amount_expected: z.string().min(1),
  amount_remaining: z.string().min(1),
  currency: z.string().length(3),
  status: z.literal("UNDERPAID"),
  metadata: z.record(z.unknown()).default({})
}).passthrough();

const failedDataSchema = z.object({
  charge_id: z.string().min(1),
  checkout_id: z.string().min(1).nullable(),
  reference: z.string().min(1).nullable(),
  status: z.enum(["FAILED", "EXPIRED"]),
  amount: z.string().min(1),
  currency: z.string().length(3),
  settlement_amount: z.string().min(1).nullable().optional(),
  settlement_currency: z.string().length(3).nullable().optional(),
  processing_fee: z.string().min(1).nullable().optional(),
  processing_fee_currency: z.string().length(3).nullable().optional(),
  fee_bearer: z.string().nullable().optional(),
  product_cart: z.unknown().nullable().optional(),
  customer: customerSchema,
  reason: z.string().nullable().optional(),
  payment_method_details: z.unknown().nullable().optional(),
  metadata: z.record(z.unknown()).default({})
}).passthrough();

const genericDataSchema = z.record(z.unknown());

const eventEnvelope = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created_at: z.string().datetime({ offset: true }),
  organization_id: z.string().min(1),
  data: genericDataSchema
}).passthrough();

export const BachsWebhookEventSchema = z.union([
  eventEnvelope.extend({ type: z.literal("checkout.completed"), data: checkoutDataSchema }),
  eventEnvelope.extend({ type: z.literal("checkout.expired"), data: checkoutDataSchema }),
  eventEnvelope.extend({ type: z.literal("collection.succeeded"), data: collectionDataSchema }),
  eventEnvelope.extend({ type: z.literal("collection.underpaid"), data: underpaidDataSchema }),
  eventEnvelope.extend({ type: z.literal("collection.failed"), data: failedDataSchema }),
  eventEnvelope
]);

export type BachsWebhookEvent = z.infer<typeof BachsWebhookEventSchema>;
type CheckoutData = z.infer<typeof checkoutDataSchema>;
type CollectionData = z.infer<typeof collectionDataSchema>;

export interface NormalizedBachsPayment {
  eventId: string;
  eventType: BachsWebhookEvent["type"];
  eventCreatedAt: string;
  reference?: string;
  amountMinor?: number;
  amountScale?: number;
  amount?: string;
  currency?: string;
  customerId?: string;
  providerPaymentId?: string;
  checkoutId?: string;
  eligible: boolean;
  status: string;
}

export interface BachsPaymentEvent extends PaymentEvent {
  id: string;
  type: BachsWebhookEvent["type"];
  created_at: string;
  organization_id: string;
  data: BachsWebhookEvent["data"];
  /** Normalized fields used by the provider-neutral core. */
  reference: string;
  amountMinor: number;
  amountScale: number;
  currency: string;
  status: string;
  customerId: string;
  providerPaymentId: string;
  checkoutId: string;
  eligible: boolean;
}

export interface BachsFixtureOptions {
  reference: string;
  amountMinor?: number;
  currency?: string;
  eligible?: boolean;
  customerId?: string;
}

function isoAt(baseMs: number, offsetMs = 0): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function expectedNoCredit(event: BachsPaymentEvent): ExpectedPaymentState {
  return {
    reference: event.reference,
    eligible: false,
    amountMinor: event.amountMinor,
    currency: event.currency,
    expectedCreditCount: 0
  };
}

function checkoutFixture(
  base: BachsPaymentEvent,
  type: "checkout.completed" | "checkout.expired",
  options: { createdAt: string; paymentStatus: string | null; charge: boolean; eligible: boolean; status: string }
): BachsPaymentEvent {
  const charge = options.charge ? { id: base.providerPaymentId } : null;
  return {
    ...base,
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type,
    created_at: options.createdAt,
    data: {
      checkout_id: base.checkoutId,
      status: options.status,
      mode: "payment",
      payment_status: options.paymentStatus,
      amount: formatBachsMoney(BigInt(base.amountMinor), 2),
      currency: base.currency,
      reference: base.reference,
      customer: { id: base.customerId, email: "synthetic@example.com", name: "Synthetic Customer" },
      charge,
      success_url: "https://example.test/success",
      cancel_url: "https://example.test/cancel",
      subscription: null,
      completed_at: options.eligible ? options.createdAt : null,
      expires_at: options.createdAt,
      metadata: { order_id: base.reference }
    } as BachsPaymentEvent["data"],
    amountMinor: base.amountMinor,
    status: options.eligible ? "SUCCEEDED" : options.status,
    eligible: options.eligible
  };
}

function delivery(event: BachsPaymentEvent, _input: ProviderScenarioInput, overrides: Partial<import("@bachsproof/core").ProviderScenarioDelivery<BachsPaymentEvent>> = {}) {
  return {
    event,
    ...overrides
  };
}

/**
 * Build documented Bachs lifecycle and rejection scenarios. These are
 * synthetic webhook deliveries for isolated, authorized test environments;
 * they do not call Bachs or create real payment state.
 */
export function createBachsScenario(scenario: ScenarioName, input: ProviderScenarioInput, customerId?: string): ProviderScenario<BachsPaymentEvent> | undefined {
  if (["concurrent-duplicate-credit", "sequential-duplicate-webhook", "concurrent-unique-payments"].includes(scenario)) return undefined;
  const reference = input.reference;
  const amountMinor = input.amountMinor ?? 5_000_000;
  const currency = input.currency ?? "NGN";
  const base = createBachsMockFixture({ reference, amountMinor, currency, customerId });
  const now = Date.now();
  const successful = () => ({
    deliveries: [delivery(base, input)],
    verification: [{ event: base, expected: expectedBachsState(base) }]
  });

  if (scenario === "cross-event-duplicate-payment") {
    const completed = checkoutFixture(base, "checkout.completed", {
      createdAt: isoAt(now),
      paymentStatus: "paid",
      charge: true,
      eligible: true,
      status: "completed"
    });
    return {
      concurrent: true,
      deliveries: [delivery(completed, input, { participantId: "checkout-completed" }), delivery(base, input, { participantId: "collection-succeeded" })],
      verification: [{ event: base, expected: expectedBachsState(base) }]
    };
  }

  if (scenario === "out-of-order-events") {
    const expired = checkoutFixture(base, "checkout.expired", {
      createdAt: isoAt(now),
      paymentStatus: null,
      charge: false,
      eligible: false,
      status: "expired"
    });
    const newerSuccess = { ...base, created_at: isoAt(now + 1_000) };
    return {
      deliveries: [delivery(newerSuccess, input, { participantId: "newer-success" }), delivery(expired, input, { participantId: "older-expired" })],
      verification: [{ event: newerSuccess, expected: expectedBachsState(newerSuccess) }]
    };
  }

  if (scenario === "incomplete-checkout") {
    const incomplete = checkoutFixture(base, "checkout.completed", {
      createdAt: isoAt(now),
      paymentStatus: "no_payment_required",
      charge: false,
      eligible: false,
      status: "completed"
    });
    return { deliveries: [delivery(incomplete, input)], verification: [{ event: incomplete, expected: expectedNoCredit(incomplete) }] };
  }

  if (scenario === "expired-checkout") {
    const expired = checkoutFixture(base, "checkout.expired", {
      createdAt: isoAt(now),
      paymentStatus: null,
      charge: false,
      eligible: false,
      status: "expired"
    });
    return { deliveries: [delivery(expired, input)], verification: [{ event: expired, expected: expectedNoCredit(expired) }] };
  }

  if (scenario === "incorrect-payment-amount") {
    const incorrect = createBachsMockFixture({ reference, amountMinor: amountMinor + 1, currency, customerId });
    return { deliveries: [delivery(incorrect, input)], verification: [{ event: incorrect, expected: expectedNoCredit(incorrect) }] };
  }

  if (scenario === "incorrect-payment-currency") {
    const incorrectCurrency = currency === "USD" ? "EUR" : "USD";
    const incorrect = createBachsMockFixture({ reference, amountMinor, currency: incorrectCurrency, customerId });
    return { deliveries: [delivery(incorrect, input)], verification: [{ event: incorrect, expected: expectedNoCredit(incorrect) }] };
  }

  if (scenario === "underpaid-payment") {
    const paidMinor = Math.max(1, Math.floor(amountMinor / 2));
    const paid = formatBachsMoney(BigInt(paidMinor), 2);
    const expectedAmount = formatBachsMoney(BigInt(amountMinor), 2);
    const remaining = formatBachsMoney(BigInt(amountMinor - paidMinor), 2);
    const underpaid: BachsPaymentEvent = {
      ...base,
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      type: "collection.underpaid",
      data: {
        charge_id: base.providerPaymentId,
        reference,
        checkout_id: base.checkoutId,
        amount_paid: paid,
        amount_expected: expectedAmount,
        amount_remaining: remaining,
        currency,
        status: "UNDERPAID",
        metadata: { order_id: reference }
      } as BachsPaymentEvent["data"],
      amountMinor: paidMinor,
      status: "UNDERPAID",
      eligible: false
    };
    return { deliveries: [delivery(underpaid, input)], verification: [{ event: underpaid, expected: expectedNoCredit(underpaid) }] };
  }

  if (scenario === "failed-payment") {
    const failed: BachsPaymentEvent = {
      ...base,
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      type: "collection.failed",
      data: {
        charge_id: base.providerPaymentId,
        checkout_id: base.checkoutId,
        reference,
        status: "FAILED",
        amount: formatBachsMoney(BigInt(amountMinor), 2),
        currency,
        settlement_amount: null,
        settlement_currency: null,
        processing_fee: null,
        processing_fee_currency: null,
        fee_bearer: "merchant",
        product_cart: null,
        customer: { id: base.customerId, email: "synthetic@example.com", name: "Synthetic Customer" },
        reason: "synthetic_test_failure",
        payment_method_details: null,
        metadata: { order_id: reference }
      } as BachsPaymentEvent["data"],
      status: "FAILED",
      eligible: false
    };
    return { deliveries: [delivery(failed, input)], verification: [{ event: failed, expected: expectedNoCredit(failed) }] };
  }

  return successful();
}

/** Generate a deterministic local fixture with the documented collection envelope. */
export function createBachsMockFixture(options: BachsFixtureOptions): BachsPaymentEvent {
  const eligible = options.eligible !== false;
  const reference = options.reference;
  const currency = options.currency ?? "NGN";
  const amountMinor = options.amountMinor ?? 5_000_000;
  const amount = formatBachsMoney(BigInt(amountMinor), 2);
  const exactAmount = parseBachsMoney(amount, currency);
  const providerPaymentId = `ch_${randomUUID().replaceAll("-", "")}`;
  const checkoutId = `chk_${randomUUID().replaceAll("-", "")}`;
  return {
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type: "collection.succeeded",
    created_at: new Date().toISOString(),
    organization_id: "acct_bachsproof_test",
    data: {
      charge_id: providerPaymentId,
      checkout_id: checkoutId,
      reference,
      status: eligible ? "SUCCEEDED" : "ACCEPTED",
      amount,
      currency,
      settlement_amount: amount,
      settlement_currency: currency,
      fee_bearer: "merchant",
      product_cart: null,
      customer: { id: options.customerId ?? "customer-test-001", email: "synthetic@example.com", name: "Synthetic Customer" },
      payment_method_details: null,
      metadata: { order_id: reference }
    },
    reference,
    amountMinor: safeNumberMoney(toBachsMinorUnits(exactAmount, 2)),
    amountScale: 2,
    currency,
    status: eligible ? "SUCCEEDED" : "ACCEPTED",
    customerId: options.customerId ?? "customer-test-001",
    providerPaymentId,
    checkoutId,
    eligible
  };
}

/** Serialize only the authentic provider envelope, excluding normalized fields. */
export function serializeBachsPaymentEvent(event: BachsPaymentEvent): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    created_at: event.created_at,
    organization_id: event.organization_id,
    data: event.data
  });
}

/** Validate an externally supplied documented Bachs webhook envelope. */
export function parseBachsWebhookEvent(value: unknown): BachsWebhookEvent {
  return BachsWebhookEventSchema.parse(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function customerId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  return stringField(candidate.id) ?? stringField(candidate.customer_id);
}

/** Normalize only fields verified in the documented event examples. */
export function normalizeBachsWebhookEvent(value: unknown): NormalizedBachsPayment {
  const event = parseBachsWebhookEvent(value);
  if (event.type === "checkout.completed" || event.type === "checkout.expired") {
    const data = event.data as CheckoutData;
    const amount = data.currency ? parseBachsMoney(data.amount, data.currency) : undefined;
    const eligible = event.type === "checkout.completed"
      && data.status === "completed"
      && data.mode === "payment"
      && data.payment_status === "paid"
      && data.charge !== null
      && data.currency !== null;
    return {
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt: event.created_at,
      reference: data.reference ?? undefined,
      amountMinor: amount ? safeNumberMoney(toBachsMinorUnits(amount, amount.scale)) : undefined,
      amountScale: amount?.scale,
      amount: data.amount,
      currency: data.currency ?? undefined,
      customerId: customerId(data.customer),
      providerPaymentId: data.charge?.id,
      checkoutId: data.checkout_id,
      eligible,
      status: eligible ? "SUCCEEDED" : data.status
    };
  }

  if (event.type === "collection.succeeded") {
    const data = event.data as CollectionData;
    const amount = parseBachsMoney(data.amount, data.currency);
    const eligible = data.status === "SUCCEEDED";
    return {
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt: event.created_at,
      reference: data.reference ?? undefined,
      amountMinor: safeNumberMoney(toBachsMinorUnits(amount, amount.scale)),
      amountScale: amount.scale,
      amount: data.amount,
      currency: data.currency,
      customerId: customerId(data.customer),
      providerPaymentId: data.charge_id ?? undefined,
      checkoutId: data.checkout_id ?? undefined,
      eligible,
      status: data.status
    };
  }

  // Underpaid and failed events are explicitly non-fulfilling. Underpaid uses
  // the documented amount_paid field for observability; it still cannot create
  // a wallet credit until a later successful event arrives.
  const data = event.data as Record<string, unknown>;
  const reference = stringField(data.reference);
  const amount = event.type === "collection.underpaid"
    ? stringField(data.amount_paid)
    : stringField(data.amount);
  const currency = stringField(data.currency);
  let amountMinor: number | undefined;
  let amountScale: number | undefined;
  if (amount && currency) {
    const exact = parseBachsMoney(amount, currency);
    amountMinor = safeNumberMoney(toBachsMinorUnits(exact, exact.scale));
    amountScale = exact.scale;
  }
  return {
    eventId: event.id,
    eventType: event.type,
    eventCreatedAt: event.created_at,
    reference,
    amountMinor,
    amountScale,
    amount,
    currency,
    customerId: customerId(data.customer),
    providerPaymentId: stringField(data.charge_id),
    checkoutId: stringField(data.checkout_id),
    eligible: false,
    status: event.type === "collection.underpaid" ? "UNDERPAID" : "FAILED"
  };
}

/** Translate provider metadata into the core's expected-state model. */
export function expectedBachsState(event: BachsPaymentEvent): ExpectedPaymentState {
  return {
    reference: event.reference,
    eligible: event.eligible,
    amountMinor: event.amountMinor,
    currency: event.currency,
    expectedCreditCount: 1
  };
}
