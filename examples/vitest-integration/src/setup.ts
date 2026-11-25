import { BachsProof, type FinancialVerifier } from "@bachsproof/core";
import { bachsAdapter } from "@bachsproof/bachs";

export function createVitestBachsProof(baseUrl: string, verify: FinancialVerifier): BachsProof {
  return new BachsProof({
    provider: bachsAdapter({ mode: "mock" }),
    target: { baseUrl, webhookPath: "/webhooks/bachs" },
    verify,
    checkpoint: { name: "after-idempotency-check", timeoutMs: 2_000 }
  });
}
