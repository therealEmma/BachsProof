import { PayProof } from "@payproof/core";
import { bachsAdapter } from "@payproof/bachs";

export function createVitestPayProof(baseUrl: string): PayProof {
  const testSecret = "payproof-example-secret";
  return new PayProof({
    provider: bachsAdapter({ mode: "mock" }),
    target: { baseUrl, webhookPath: "/webhooks/bachs", headers: { "x-payproof-test-secret": testSecret } },
    verification: { endpoint: "/__payproof/state" },
    checkpoint: { name: "after-idempotency-check", timeoutMs: 2_000 }
  });
}
