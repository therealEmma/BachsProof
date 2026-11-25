import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { PaymentEvent, ProviderAdapter } from "@payproof/core";
import { runConfig } from "./runner.js";
import type { PayProofConfig } from "./types.js";

interface TestEvent extends PaymentEvent {
  providerEventId: string;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("CLI configuration runner", () => {
  it("supports a custom provider adapter and committed-state callback", async () => {
    let deliveries = 0;
    let verificationContext: import("@payproof/core").FinancialVerificationContext | undefined;
    const server = createServer((_request, response) => {
      deliveries += 1;
      response.statusCode = 200;
      response.end("accepted");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test webhook server did not start");

    const provider: ProviderAdapter<TestEvent> = {
      name: "test-provider",
      mode: "fixture",
      createPayment(input = {}) {
        return {
          providerEventId: "evt-cli-callback",
          reference: input.reference ?? "CLI-CALLBACK-001",
          amountMinor: input.amountMinor ?? 1_250,
          currency: input.currency ?? "NGN",
          status: "SUCCEEDED"
        };
      },
      serialize(event) {
        return JSON.stringify({
          id: event.providerEventId,
          reference: event.reference,
          amount: event.amountMinor,
          currency: event.currency,
          status: event.status
        });
      },
      expectedState(event) {
        return {
          reference: event.reference,
          eligible: true,
          amountMinor: event.amountMinor,
          currency: event.currency,
          expectedCreditCount: 1
        };
      }
    };

    const config: PayProofConfig<TestEvent> = {
      provider,
      target: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        webhookPath: "/webhooks/test-provider",
      },
      tests: [{
        name: "custom provider callback",
        scenario: "sequential-duplicate-webhook",
        reference: "CLI-CALLBACK-001",
        amountMinor: 1_250,
        currency: "NGN"
      }],
      requireFinancialVerification: true,
      verify: async (reference, context) => {
        verificationContext = context;
        return {
          reference,
          creditCount: 1,
          creditedAmountMinor: 1_250,
          currency: "NGN"
        };
      }
    };

    const [run] = await runConfig(config);
    expect(run?.result.passed).toBe(true);
    expect(run?.result.report.financiallyVerified).toBe(true);
    expect(run?.result.report.verificationMode).toBe("callback");
    expect(deliveries).toBe(2);
    expect(verificationContext?.scenario).toBe("sequential-duplicate-webhook");
    expect(verificationContext?.paymentReference).toBe("CLI-CALLBACK-001");
    expect(verificationContext?.eventIdentifiers).toEqual(["evt-cli-callback"]);
    expect(verificationContext?.deliveries).toHaveLength(2);
  });

  it("prepares fresh references for selected scenarios and rejects explicit reuse", async () => {
    let deliveries = 0;
    const contexts: Array<{ scenario: string; paymentIndex: number; paymentCount: number }> = [];
    const server = createServer((_request, response) => {
      deliveries += 1;
      response.statusCode = 200;
      response.end("accepted");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test webhook server did not start");

    const provider: ProviderAdapter = {
      name: "test-preparation-provider",
      mode: "fixture",
      createPayment(input = {}) {
        return {
          reference: input.reference ?? "CLI-PREPARED-FALLBACK",
          amountMinor: input.amountMinor ?? 1_000,
          currency: input.currency ?? "NGN",
          status: "SUCCEEDED"
        };
      },
      serialize(event) { return JSON.stringify(event); },
      expectedState(event) { return { reference: event.reference, eligible: true, amountMinor: event.amountMinor, currency: event.currency, expectedCreditCount: 1 }; }
    };
    let referenceNumber = 0;
    const config: PayProofConfig = {
      provider,
      target: { baseUrl: `http://127.0.0.1:${address.port}`, webhookPath: "/webhooks/payment" },
      tests: [
        { name: "prepared single", scenario: "sequential-duplicate-webhook" },
        { name: "prepared unique", scenario: "concurrent-unique-payments", concurrency: 2 },
        { name: "reused explicit", scenario: "sequential-duplicate-webhook", reference: "EXPLICIT-REUSED" },
        { name: "reused explicit again", scenario: "concurrent-duplicate-credit", reference: "EXPLICIT-REUSED", concurrency: 2 }
      ],
      createPayment: (context) => {
        contexts.push({ scenario: context.scenario, paymentIndex: context.paymentIndex, paymentCount: context.paymentCount });
        referenceNumber += 1;
        return `CLI-PREPARED-${referenceNumber}`;
      }
    };

    const results = await runConfig(config);
    expect(results[0]?.result.passed).toBe(true);
    expect(results[1]?.result.passed).toBe(true);
    expect(results[2]?.result.passed).toBe(true);
    expect(results[3]?.result.passed).toBe(false);
    expect(results[3]?.result.report.errors[0]).toContain("already assigned to another selected scenario");
    expect(results[3]?.result.report.deliveries).toEqual([]);
    expect(contexts).toEqual([
      { scenario: "sequential-duplicate-webhook", paymentIndex: 0, paymentCount: 1 },
      { scenario: "concurrent-unique-payments", paymentIndex: 0, paymentCount: 2 },
      { scenario: "concurrent-unique-payments", paymentIndex: 1, paymentCount: 2 }
    ]);
    expect(deliveries).toBe(6);
  });
});
