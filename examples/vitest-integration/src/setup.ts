import type { BachsProofConfig } from "@bachsproof/cli";
import type { PaymentReferenceCreator, FinancialVerifier } from "@bachsproof/core";

/** The same object can be passed to runConfig from Vitest, Jest, or a script. */
export function createVitestBachsProof(
  webhookUrl: string,
  createPayment: PaymentReferenceCreator,
  verify: FinancialVerifier
): BachsProofConfig {
  return {
    webhookUrl,
    secret: "vitest-test-secret",
    amountMinor: 5_000_000,
    currency: "NGN",
    createPayment,
    verify
  };
}
