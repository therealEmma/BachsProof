/** The eleven financial correctness scenarios supported by BachsProof v2. */
export const SUPPORTED_SCENARIOS = [
  "sequential-duplicate-webhook",
  "concurrent-duplicate-credit",
  "concurrent-unique-payments",
  "cross-event-duplicate-payment",
  "out-of-order-events",
  "incomplete-checkout",
  "expired-checkout",
  "incorrect-payment-amount",
  "incorrect-payment-currency",
  "underpaid-payment",
  "failed-payment"
] as const;

export type ScenarioName = typeof SUPPORTED_SCENARIOS[number];

/** Minimal shape every provider adapter event must expose to the core engine. */
export interface PaymentEvent {
  reference: string;
  amountMinor: number;
  currency: string;
  status: string;
  [key: string]: unknown;
}

/** Context supplied to a financial verifier for one inspected reference. */
export interface FinancialVerificationContext {
  scenario: ScenarioName;
  paymentReference: string;
  expected: ExpectedPaymentState;
  expectedOutcome: {
    eligible: boolean;
    expectedCreditCount: number;
    amountMinor: number;
    currency: string;
  };
  events: PaymentEvent[];
  eventIdentifiers: string[];
  deliveries: DeliveryRecord[];
}

/** Information needed to create one fresh application payment. */
export interface PaymentPreparationContext {
  scenario: ScenarioName;
  amountMinor: number;
  currency: string;
  /** Zero-based index within the payments required by this scenario. */
  paymentIndex: number;
  paymentCount: number;
}

/** Create a fresh application payment/order and return its reference. */
export type PaymentReferenceCreator = (context: PaymentPreparationContext) => Promise<string> | string;

/** The state the application should have after processing one synthetic event. */
export interface ExpectedPaymentState {
  reference: string;
  eligible: boolean;
  amountMinor: number;
  currency: string;
  expectedCreditCount: number;
}

export type ExpectedHttpStatus = number | number[] | "2xx" | "4xx" | "5xx";

/** One raw webhook delivery in a provider-defined scenario. */
export interface ProviderScenarioDelivery<TEvent extends PaymentEvent = PaymentEvent> {
  event?: TEvent;
  participantId?: string;
  delayMs?: number;
  expectedStatus?: ExpectedHttpStatus;
}

/** Optional provider-specific delivery plan for a named scenario. */
export interface ProviderScenario<TEvent extends PaymentEvent = PaymentEvent> {
  deliveries: ProviderScenarioDelivery<TEvent>[];
  /** Deliver all entries together when true; otherwise preserve listed order. */
  concurrent?: boolean;
  /** State entries to inspect after delivery, with scenario-specific expectations. */
  verification?: Array<{
    event: TEvent;
    expected?: ExpectedPaymentState;
  }>;
}

/** Internal input available to an adapter after application payment preparation. */
export interface ProviderScenarioInput extends RunOptions {
  reference: string;
  references: string[];
}

/**
 * Provider plug-in contract. The core never knows how a Bachs event (or a
 * future provider event) is shaped on the wire; it only uses this contract.
 */
export interface ProviderAdapter<TEvent extends PaymentEvent = PaymentEvent> {
  readonly name: string;
  readonly mode: string;
  createPayment(input: {
    reference: string;
    amountMinor: number;
    currency: string;
    eligible?: boolean;
    customerId?: string;
  }): TEvent;
  serialize(event: TEvent): string;
  expectedState(event: TEvent): ExpectedPaymentState;
  headers?(event: TEvent): Record<string, string>;
  /** Optional signing hook that receives the exact bytes used for the request. */
  headersForBody?(event: TEvent, body: string | Uint8Array): Record<string, string>;
  /** Provider adapters expose only the supported financial scenarios. */
  createScenario?(scenario: ScenarioName, input: ProviderScenarioInput): ProviderScenario<TEvent> | undefined;
}

/** Minor-unit values accepted from database adapters without unsafe conversion. */
export type MinorUnitValue = number | bigint | string;

/** Normalized persisted financial state returned by a developer verifier. */
export interface ObservedPaymentState {
  reference: string;
  status: string;
  currency: string;
  creditedAmountMinor: number;
  creditCount: number;
  /** True while relevant application work is still incomplete. */
  pending?: boolean;
  ledgerEntries: Array<{
    id: string;
    type: string;
    amountMinor: number;
    currency?: string;
  }>;
}

export type InvariantId = "INV-001" | "INV-002" | "INV-003" | "INV-004" | "INV-005";

export interface InvariantViolation {
  id: InvariantId;
  name: string;
  message: string;
  reference: string;
}

/** Result of evaluating all five financial invariants for one reference. */
export interface VerificationResult {
  passed: boolean;
  violations: InvariantViolation[];
}

/** One attempted webhook delivery, including its HTTP outcome and timing. */
export interface DeliveryRecord {
  deliveryId: string;
  participantId: string;
  reference: string;
  eventId?: string;
  eventType?: string;
  startedAt: string;
  completedAt?: string;
  status?: number;
  responseBody?: string;
  expectedStatus?: ProviderScenarioDelivery["expectedStatus"];
  error?: string;
}

export type FailureType =
  | "payment-preparation"
  | "webhook-delivery"
  | "unexpected-http-response"
  | "financial-verification"
  | "financial-verification-timeout"
  | "invariant-violation";

/** Structured report for automation and debugging. */
export interface BachsProofReport {
  reportVersion: "2.0";
  scenario: ScenarioName;
  provider: string;
  paymentReference: string;
  event: PaymentEvent;
  expected: ExpectedPaymentState;
  observed?: ObservedPaymentState;
  verification?: VerificationResult;
  /** True only when the verifier returned independently observed state. */
  financiallyVerified: boolean;
  payments?: Array<{
    event: PaymentEvent;
    expected: ExpectedPaymentState;
    observed: ObservedPaymentState;
    verification: VerificationResult;
  }>;
  deliveries: DeliveryRecord[];
  errors: string[];
  failureType?: FailureType;
  startedAt: string;
  completedAt?: string;
}

export interface BachsProofResult {
  passed: boolean;
  report: BachsProofReport;
}

/** Callback polling and observation settings used internally by the CLI. */
export interface FinancialVerificationOptions {
  completionDeadlineMs?: number;
  pollIntervalMs?: number;
  /** How long a negative scenario must remain observed with no credit. */
  negativeObservationWindowMs?: number;
}

/** Public shape returned by the developer's financial verification callback. */
export interface FinancialVerificationInput {
  reference: string;
  creditCount: number;
  creditedAmountMinor: MinorUnitValue;
  currency: string;
  status?: string;
  pending?: boolean;
  ledgerEntries?: Array<{
    id: string;
    type: string;
    amountMinor: MinorUnitValue;
    currency?: string;
  }>;
}

/** One-argument callbacks remain valid; the second argument is optional. */
export type FinancialVerifier = (reference: string, context?: FinancialVerificationContext) => Promise<FinancialVerificationInput> | FinancialVerificationInput;

/** Internal runner options. The CLI is the supported public entry point. */
export interface BachsProofOptions<TEvent extends PaymentEvent = PaymentEvent> {
  provider: ProviderAdapter<TEvent>;
  webhookUrl: string;
  createPayment: PaymentReferenceCreator;
  verify: FinancialVerifier;
  financialVerification?: FinancialVerificationOptions;
}

/** Per-run settings created by the simplified CLI configuration. */
export interface RunOptions {
  scenario: ScenarioName;
  concurrency?: number;
  amountMinor?: number;
  currency?: string;
}
