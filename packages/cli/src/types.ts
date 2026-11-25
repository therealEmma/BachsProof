import type {
  FinancialVerifier,
  FinancialVerificationOptions,
  PaymentReferenceCreator,
  BachsProofTarget,
  PaymentEvent,
  ProviderAdapter,
  RunOptions
} from "@bachsproof/core";

export interface BachsProofCliTest extends Omit<RunOptions, "scenario"> {
  name: string;
  scenario: RunOptions["scenario"];
}

export interface BachsSigningConfig {
  type: "bachs";
  secret: string;
  timestamp?: number;
}

export interface BachsProofConfig<TEvent extends PaymentEvent = PaymentEvent> {
  provider: ProviderAdapter<TEvent>;
  target: BachsProofTarget;
  tests: BachsProofCliTest[];
  /** Optional test-only callback that creates fresh application payments. */
  createPayment?: PaymentReferenceCreator;
  verify?: FinancialVerifier;
  financialVerification?: FinancialVerificationOptions;
  checkpoint?: {
    name: string;
    timeoutMs?: number;
  };
  signing?: BachsSigningConfig;
  /** Fail the CLI when the config has no committed-state verifier. */
  requireFinancialVerification?: boolean;
}

export interface BachsProofCliRun {
  name: string;
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
