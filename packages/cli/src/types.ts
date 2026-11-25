import type {
  FinancialVerifier,
  PaymentReferenceCreator,
  PayProofTarget,
  PaymentEvent,
  PayProofVerificationOptions,
  ProviderAdapter,
  RunOptions
} from "@payproof/core";

export interface PayProofCliTest extends Omit<RunOptions, "scenario"> {
  name: string;
  scenario: RunOptions["scenario"];
}

export interface BachsSigningConfig {
  type: "bachs";
  secret: string;
  timestamp?: number;
}

export interface PayProofConfig<TEvent extends PaymentEvent = PaymentEvent> {
  provider: ProviderAdapter<TEvent>;
  target: PayProofTarget;
  tests: PayProofCliTest[];
  /** Optional test-only callback that creates fresh application payments. */
  createPayment?: PaymentReferenceCreator;
  verify?: FinancialVerifier;
  verification?: PayProofVerificationOptions;
  checkpoint?: {
    name: string;
    timeoutMs?: number;
  };
  signing?: BachsSigningConfig;
  /** Fail the CLI when the config has no committed-state verifier. */
  requireFinancialVerification?: boolean;
}

export interface PayProofCliRun {
  name: string;
  result: import("@payproof/core").PayProofResult;
}

export interface PayProofSummary {
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
