import type {
  FinancialVerifier,
  PaymentEvent,
  PaymentReferenceCreator,
  ScenarioName
} from "@bachsproof/core";

/** The only developer-facing configuration supported by BachsProof v2. */
export interface BachsProofConfig<TEvent extends PaymentEvent = PaymentEvent> {
  /** Complete URL of the isolated application's Bachs webhook route. */
  webhookUrl: string;
  /** Test-only secret used to sign every generated webhook automatically. */
  secret: string;
  /** Default integer amount in minor units. */
  amountMinor: number;
  /** Default three-letter ISO currency code. */
  currency: string;
  /** Creates a fresh application payment and returns its reference. */
  createPayment: PaymentReferenceCreator;
  /** Reads the committed payment and ledger state for a prepared reference. */
  verify: FinancialVerifier;
  /** Run a subset; omitted means the five standard scenarios. */
  scenarios?: ScenarioName[];
  /** Increase the default asynchronous financial observation deadline if needed. */
  verificationTimeoutMs?: number;
}

export interface BachsProofCliRun {
  name: string;
  scenario: ScenarioName;
  result: import("@bachsproof/core").BachsProofResult;
}

export interface BachsProofSummary {
  total: number;
  passed: number;
  failed: number;
  financiallyVerified: number;
  financiallyUnverified: number;
  financialViolations: number;
  durationMs: number;
}

export interface RunConfigOptions {
  testName?: string;
}
