import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BachsProof } from "./orchestrator.js";
import type { FinancialVerifier, PaymentEvent, ProviderAdapter } from "./types.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function provider(): ProviderAdapter {
  return {
    name: "test-provider",
    mode: "fixture",
    createPayment(input) {
      return { reference: input.reference, amountMinor: input.amountMinor, currency: input.currency, status: "SUCCEEDED", id: "evt-1" };
    },
    serialize(event) { return JSON.stringify(event); },
    expectedState(event) { return { reference: event.reference, eligible: true, amountMinor: event.amountMinor, currency: event.currency, expectedCreditCount: 1 }; }
  };
}

async function webhook(status = 200): Promise<{ url: string; requests: number[] }> {
  const requests: number[] = [];
  const server = createServer((_request, response) => {
    requests.push(1);
    response.statusCode = status;
    response.end("accepted");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test webhook server did not start");
  return { url: `http://127.0.0.1:${address.port}/webhooks/payment`, requests };
}

const passingVerifier: FinancialVerifier = (reference, context) => ({
  reference,
  creditCount: context?.expectedOutcome.eligible ? 1 : 0,
  creditedAmountMinor: context?.expectedOutcome.eligible ? context.expectedOutcome.amountMinor : 0,
  currency: context?.expectedOutcome.currency ?? "NGN",
  ledgerEntries: []
});

describe("BachsProof v2 runner", () => {
  it("requires both application callbacks", () => {
    expect(() => new BachsProof({ provider: provider(), webhookUrl: "http://127.0.0.1:1/hook", createPayment: () => "x" } as never)).toThrow("verify callback");
  });

  it("prepares a fresh reference and verifies financial state after delivery", async () => {
    const target = await webhook();
    const contexts: Array<{ paymentIndex: number; paymentCount: number }> = [];
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: (context) => {
        contexts.push({ paymentIndex: context.paymentIndex, paymentCount: context.paymentCount });
        return `PAY-${context.paymentIndex}`;
      },
      verify: passingVerifier
    }).run({ scenario: "concurrent-unique-payments", amountMinor: 1_250, currency: "NGN" });

    expect(result.passed).toBe(true);
    expect(result.report.financiallyVerified).toBe(true);
    expect(target.requests).toHaveLength(2);
    expect(contexts).toEqual([{ paymentIndex: 0, paymentCount: 2 }, { paymentIndex: 1, paymentCount: 2 }]);
    expect(result.report.payments).toHaveLength(2);
  });

  it("fails when HTTP delivery is unsuccessful even if financial evidence is available", async () => {
    const target = await webhook(503);
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: () => "PAY-HTTP-FAIL",
      verify: passingVerifier
    }).run({ scenario: "sequential-duplicate-webhook" });

    expect(result.passed).toBe(false);
    expect(result.report.financiallyVerified).toBe(true);
    expect(result.report.failureType).toBe("unexpected-http-response");
    expect(result.report.errors[0]).toContain("HTTP 503");
  });

  it("rejects duplicate references from payment preparation", async () => {
    const target = await webhook();
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: () => "PAY-DUPLICATE",
      verify: passingVerifier
    }).run({ scenario: "concurrent-unique-payments" });

    expect(result.passed).toBe(false);
    expect(result.report.failureType).toBe("payment-preparation");
    expect(result.report.deliveries).toEqual([]);
  });
});
