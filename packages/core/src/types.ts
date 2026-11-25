/** Scenarios implemented by the provider-neutral runner and provider adapters. */
export type ScenarioName =
  | "concurrent-duplicate-credit"
  | "sequential-duplicate-webhook"
  | "concurrent-unique-payments"
  | "cross-event-duplicate-payment"
  | "out-of-order-events"
  | "delayed-payment-confirmation"
  | "incomplete-checkout"
  | "expired-checkout"
  | "tampered-webhook"
  | "invalid-webhook-signature"
  | "malformed-webhook"
  | "incorrect-payment-amount"
  | "incorrect-payment-currency"
  | "underpaid-payment"
  | "failed-payment";

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

/** Test-only input supplied to the application's payment preparation callback. */
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

/** HTTP outcome accepted for one deliberately rejected delivery. */
export type ExpectedHttpStatus = number | number[] | "2xx" | "4xx" | "5xx";

/** One raw webhook delivery in a provider-defined scenario. */
export interface ProviderScenarioDelivery<TEvent extends PaymentEvent = PaymentEvent> {
  event?: TEvent;
  /** Override the provider serialization for malformed/tampered-body tests. */
  body?: string | Uint8Array;
  /** Sign this body while sending `body`, used for tampered-body tests. */
  signingBody?: string | Uint8Array;
  /** Explicit headers win over adapter-generated headers. */
  headers?: Record<string, string>;
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

/**
 * Provider plug-in contract. The core never knows how a Bachs event (or a
 * future provider event) is shaped on the wire; it only uses this contract.
 */
export interface ProviderAdapter<TEvent extends PaymentEvent = PaymentEvent> {
  readonly name: string;
  readonly mode: string;
  createPayment(input?: {
    reference?: string;
    amountMinor?: number;
    currency?: string;
    eligible?: boolean;
    customerId?: string;
    syntheticReferences?: boolean;
  }): TEvent;
  serialize(event: TEvent): string;
  expectedState(event: TEvent): ExpectedPaymentState;
  headers?(event: TEvent): Record<string, string>;
  /** Optional signing hook that receives the exact bytes used for the request. */
  headersForBody?(event: TEvent, body: string | Uint8Array): Record<string, string>;
  /** Provider adapters may expose documented event-lifecycle scenarios. */
  createScenario?(scenario: ScenarioName, input: RunOptions): ProviderScenario<TEvent> | undefined;
}

/**
 * Normalized persisted financial state returned by a developer-supplied
 * verification callback.
 */
export interface ObservedPaymentState {
  reference: string;
  status: string;
  currency: string;
  creditedAmountMinor: number;
  creditCount: number;
  /** Optional application signal that asynchronous processing is incomplete. */
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

/** Result of evaluating all configured financial invariants for one reference. */
export interface VerificationResult {
  passed: boolean;
  violations: InvariantViolation[];
}

/** One attempted webhook delivery, including its HTTP outcome and timing. */
export interface DeliveryRecord {
  deliveryId: string;
  participantId: string;
  reference: string;
  eventId?: string | undefined;
  eventType?: string | undefined;
  startedAt: string;
  completedAt?: string | undefined;
  status?: number | undefined;
  responseBody?: string | undefined;
  expectedStatus?: ExpectedHttpStatus | undefined;
  error?: string | undefined;
}

/** An append-only event emitted by the race controller for replay/debugging. */
export interface CheckpointTraceEvent {
  type: "arrival" | "release" | "abort";
  at: string;
  sessionId: string;
  checkpoint: string;
  participantId?: string | undefined;
  key?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  reason?: string | undefined;
}

/** Structured report persisted by callers when they need a durable failure trace. */
export interface BachsProofReport {
  reportVersion: "1.1";
  scenario: ScenarioName;
  provider: string;
  mode: string;
  paymentReference: string;
  event: PaymentEvent;
  expected: ExpectedPaymentState;
  observed?: ObservedPaymentState;
  verification?: VerificationResult;
  /** Which financial verification integration was used for this run. */
  verificationMode: "callback" | "none";
  /** False means HTTP delivery ran, but financial correctness was not established. */
  financiallyVerified: boolean;
  payments?: Array<{
    event: PaymentEvent;
    expected: ExpectedPaymentState;
    observed: ObservedPaymentState;
    verification: VerificationResult;
  }>;
  deliveries: DeliveryRecord[];
  checkpoints: CheckpointTraceEvent[];
  errors: string[];
  replay: {
    seed: string;
    concurrency: number;
    checkpoint?: string;
    controlled: boolean;
    note: string;
  };
  startedAt: string;
  completedAt?: string;
}

export interface BachsProofResult {
  passed: boolean;
  report: BachsProofReport;
}

/** Network details for the application under test. */
export interface BachsProofTarget {
  baseUrl: string;
  webhookPath: string;
  headers?: Record<string, string>;
}

/** Callback polling and observation settings. */
export interface FinancialVerificationOptions {
  completionDeadlineMs?: number;
  pollIntervalMs?: number;
  /** How long a negative scenario must remain observed with no credit. */
  negativeObservationWindowMs?: number;
}

/**
 * The intentionally small callback contract recommended for TypeScript users.
 * Callers can use Prisma, SQL, an in-memory ledger, or any other test store.
 */
export interface FinancialVerificationInput {
  reference: string;
  creditCount: number;
  creditedAmountMinor: number;
  currency: string;
  status?: string;
  pending?: boolean;
  ledgerEntries?: Array<{
    id: string;
    type: string;
    amountMinor: number;
    currency?: string;
  }>;
}

/** One-argument callbacks remain valid; the second argument is optional. */
export type FinancialVerifier = (reference: string, context?: FinancialVerificationContext) => Promise<FinancialVerificationInput> | FinancialVerificationInput;

export interface BachsProofOptions<TEvent extends PaymentEvent = PaymentEvent> {
  provider: ProviderAdapter<TEvent>;
  target: BachsProofTarget;
  /** Optional test-only application payment/order preparation callback. */
  createPayment?: PaymentReferenceCreator;
  /** Optional test-only callback that reads committed financial state. */
  verify?: FinancialVerifier;
  /** Optional polling settings for asynchronous callback verification. */
  financialVerification?: FinancialVerificationOptions;
  checkpoint?: {
    name: string;
    timeoutMs?: number;
  };
}

/** Per-run scenario settings, including replay overrides. */
export interface RunOptions {
  scenario: ScenarioName;
  concurrency?: number;
  amountMinor?: number;
  currency?: string;
  reference?: string;
  /** Explicit references for concurrent-unique-payments. */
  references?: string[];
  /** Synthetic references are opt-in; real application references are default. */
  syntheticReferences?: boolean;
  /** Optional expected HTTP status/outcome for scenario deliveries. */
  expectedStatus?: ExpectedHttpStatus;
  /** Optional bounded delay used by delayed provider scenarios. */
  delayMs?: number;
  seed?: string;
  replay?: BachsProofReport;
}
