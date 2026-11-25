import { PayProof, type FinancialVerifier } from "@payproof/core";
import { bachsAdapter } from "@payproof/bachs";

export function createVitestPayProof(baseUrl: string, verify: FinancialVerifier): PayProof {
  return new PayProof({
    provider: bachsAdapter({ mode: "mock" }),
    target: { baseUrl, webhookPath: "/webhooks/bachs" },
    verify,
    checkpoint: { name: "after-idempotency-check", timeoutMs: 2_000 }
  });
}
