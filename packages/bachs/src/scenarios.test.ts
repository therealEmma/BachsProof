import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PayProof, type FinancialVerificationInput } from "@payproof/core";
import { bachsAdapter, signBachsWebhook, type BachsPaymentEvent } from "./index.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const zeroCreditScenarios = new Set([
  "incomplete-checkout",
  "expired-checkout",
  "tampered-webhook",
  "invalid-webhook-signature",
  "malformed-webhook",
  "incorrect-payment-amount",
  "incorrect-payment-currency",
  "underpaid-payment",
  "failed-payment"
]);

describe("Bachs provider scenarios", () => {
  it.each([
    "cross-event-duplicate-payment",
    "out-of-order-events",
    "delayed-payment-confirmation",
    "incomplete-checkout",
    "expired-checkout",
    "tampered-webhook",
    "invalid-webhook-signature",
    "malformed-webhook",
    "incorrect-payment-amount",
    "incorrect-payment-currency",
    "underpaid-payment",
    "failed-payment"
  ] as const)("runs %s with the expected delivery and financial outcome", async (scenario) => {
    const requests: Array<{ body: string; headers: Record<string, string> }> = [];
    const shouldReject = ["tampered-webhook", "invalid-webhook-signature", "malformed-webhook"].includes(scenario);
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ body: Buffer.concat(chunks).toString("utf8"), headers: request.headers as Record<string, string> });
        response.statusCode = shouldReject ? 400 : 200;
        response.end(shouldReject ? "rejected as expected" : "accepted");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("scenario server did not start");

    const baseProvider = bachsAdapter({ mode: "mock", customerId: `customer-${scenario}` });
    let verificationCalls = 0;
    const provider = {
      ...baseProvider,
      headersForBody(event: BachsPaymentEvent, body: string | Uint8Array) {
        return {
          ...(baseProvider.headers?.(event) ?? {}),
          ...signBachsWebhook(body, "synthetic-test-secret")
        };
      }
    };
    const payproof = new PayProof({
      provider,
      target: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        webhookPath: "/webhooks/bachs",
        reset: false
      },
      verify(reference, context): FinancialVerificationInput {
        verificationCalls += 1;
        expect(context?.scenario).toBe(scenario);
        expect(context?.paymentReference).toBe(reference);
        expect(context?.expectedOutcome).toBeDefined();
        expect(context?.deliveries.length).toBeGreaterThan(0);
        const creditCount = zeroCreditScenarios.has(scenario) ? 0 : 1;
        return {
          reference,
          creditCount,
          creditedAmountMinor: creditCount === 0 ? 0 : 5_000_000,
          currency: "NGN",
          pending: scenario === "incomplete-checkout" && verificationCalls === 1,
          ledgerEntries: []
        };
      }
    });

    const result = await payproof.run({
      scenario,
      reference: `PAYPROOF-SCENARIO-${scenario}`,
      amountMinor: 5_000_000,
      currency: "NGN",
      expectedStatus: shouldReject ? 400 : undefined
    });

    expect(result.passed).toBe(true);
    expect(result.report.financiallyVerified).toBe(true);
    expect(result.report.verification?.passed).toBe(true);
    expect(result.report.errors).toEqual([]);
    expect(requests).toHaveLength(["cross-event-duplicate-payment", "out-of-order-events", "delayed-payment-confirmation"].includes(scenario) ? 2 : 1);
    expect(result.report.deliveries.every((delivery) => delivery.status === (shouldReject ? 400 : 200))).toBe(true);
    if (scenario === "incomplete-checkout") expect(verificationCalls).toBeGreaterThanOrEqual(2);

    if (scenario === "tampered-webhook") {
      const body = JSON.parse(requests[0]?.body ?? "{}");
      expect(body.type).toBe("collection.succeeded");
      expect(requests[0]?.headers["x-bachs-signature-v2"]).toContain("v1=");
    }
    if (["cross-event-duplicate-payment", "out-of-order-events", "delayed-payment-confirmation"].includes(scenario)) {
      expect(requests.map(({ body }) => JSON.parse(body).type)).toContain("collection.succeeded");
    }
  });

  it("uses explicitly supplied references for concurrent unique payments", async () => {
    const seen: string[] = [];
    const server = createServer((_request, response) => response.end("accepted"));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unique-payment server did not start");
    const provider = bachsAdapter({ mode: "mock" });
    const result = await new PayProof({
      provider,
      target: { baseUrl: `http://127.0.0.1:${address.port}`, webhookPath: "/webhooks/bachs", reset: false },
      verify(reference) {
        seen.push(reference);
        return { reference, creditCount: 1, creditedAmountMinor: 5_000_000, currency: "NGN", ledgerEntries: [] };
      }
    }).run({
      scenario: "concurrent-unique-payments",
      references: ["PAYPROOF-UNIQUE-A", "PAYPROOF-UNIQUE-B"],
      amountMinor: 5_000_000,
      currency: "NGN"
    });

    expect(result.passed).toBe(true);
    expect(seen.sort()).toEqual(["PAYPROOF-UNIQUE-A", "PAYPROOF-UNIQUE-B"]);
    expect(result.report.payments).toHaveLength(2);
  });
});
