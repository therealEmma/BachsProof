import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BachsProof } from "./orchestrator.js";
import type { ExpectedHttpStatus, FinancialVerifier, PaymentEvent, ProviderAdapter } from "./types.js";

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

async function webhook(status = 200, body = "accepted"): Promise<{ url: string; requests: number[] }> {
  const requests: number[] = [];
  const server = createServer((_request, response) => {
    requests.push(1);
    response.statusCode = status;
    if (status >= 300 && status < 400) response.setHeader("location", "/redirected");
    response.end(body);
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

function plannedProvider(expectedStatus: ExpectedHttpStatus, eligible = true): ProviderAdapter {
  const base = provider();
  return {
    ...base,
    createScenario(_scenario, input) {
      const event = base.createPayment({
        reference: input.reference,
        amountMinor: input.amountMinor ?? 500_000,
        currency: input.currency ?? "NGN"
      });
      return {
        deliveries: [{ event, expectedStatus }],
        verification: [{
          event,
          expected: {
            reference: event.reference,
            eligible,
            amountMinor: eligible ? event.amountMinor : 0,
            currency: event.currency,
            expectedCreditCount: eligible ? 1 : 0
          }
        }]
      };
    }
  };
}

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
    expect(result.report.financialOutcome).toBe("PASS");
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
    expect(result.report.financialOutcome).toBe("PASS");
    expect(result.report.failureType).toBe("unexpected-http-response");
    expect(result.report.errors[0]).toContain("HTTP 503");
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("infrastructure-failure");
    expect(result.report.deliveries[0]?.responseBody).toBe("accepted");
  });

  it.each([500, 502, 504])("classifies HTTP %s as a server-side delivery failure", async (status) => {
    const target = await webhook(status, "server failure");
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: () => `PAY-SERVER-${status}`,
      verify: passingVerifier
    }).run({ scenario: "sequential-duplicate-webhook" });

    expect(result.passed).toBe(false);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("infrastructure-failure");
    expect(result.report.financialOutcome).toBe("PASS");
  });

  it("does not treat an undeclared HTTP 400 as an intentional rejection", async () => {
    const target = await webhook(400, "malformed webhook");
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: () => "PAY-MALFORMED-400",
      verify: passingVerifier
    }).run({ scenario: "sequential-duplicate-webhook" });

    expect(result.passed).toBe(false);
    expect(result.report.financialOutcome).toBe("PASS");
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("unexpected-http-response");
    expect(result.report.deliveries[0]?.responseBody).toBe("malformed webhook");
  });

  it("classifies authentication failures separately from delivery failures", async () => {
    const target = await webhook(401, "invalid signature");
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: () => "PAY-AUTH-FAIL",
      verify: passingVerifier
    }).run({ scenario: "sequential-duplicate-webhook" });

    expect(result.passed).toBe(false);
    expect(result.report.financialOutcome).toBe("PASS");
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("authentication-failure");
  });

  it("allows only a scenario-declared 400/422 as a potential intentional rejection", async () => {
    const target = await webhook(422, "amount rejected");
    const result = await new BachsProof({
      provider: plannedProvider(["2xx", 400, 409, 422], false),
      webhookUrl: target.url,
      createPayment: () => "PAY-EXPECTED-422",
      verify: passingVerifier
    }).run({ scenario: "incorrect-payment-amount" });

    expect(result.passed).toBe(true);
    expect(result.report.financialOutcome).toBe("PASS");
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("expected-rejection");
    expect(result.report.deliveries[0]?.responseBody).toBe("amount rejected");
  });

  it.each([200, 201, 202, 204])("accepts HTTP %s as a successful delivery acknowledgment", async (status) => {
    const target = await webhook(status);
    const result = await new BachsProof({
      provider: plannedProvider("2xx"),
      webhookUrl: target.url,
      createPayment: () => `PAY-${status}`,
      verify: passingVerifier
    }).run({ scenario: "incorrect-payment-amount" });

    expect(result.passed).toBe(true);
    expect(result.report.deliveries[0]?.status).toBe(status);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("passed");
  });

  it.each([400, 409, 422])("allows HTTP %s only for an explicitly rejecting delivery", async (status) => {
    const target = await webhook(status, "rejected");
    const result = await new BachsProof({
      provider: plannedProvider(["2xx", 400, 409, 422], false),
      webhookUrl: target.url,
      createPayment: () => `PAY-REJECT-${status}`,
      verify: passingVerifier
    }).run({ scenario: "incorrect-payment-amount" });

    expect(result.passed).toBe(true);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("expected-rejection");
    expect(result.report.financialOutcome).toBe("PASS");
  });

  it.each([400, 409, 422])("rejects an undeclared HTTP %s on a valid payment delivery", async (status) => {
    const target = await webhook(status, "unexpected rejection");
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: ({ paymentIndex }) => `PAY-UNEXPECTED-${status}-${paymentIndex}`,
      verify: passingVerifier
    }).run({ scenario: "concurrent-unique-payments" });

    expect(result.passed).toBe(false);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("unexpected-http-response");
    expect(result.report.financialOutcome).toBe("PASS");
  });

  it.each([301, 302, 304, 307, 308])("does not follow HTTP %s redirects", async (status) => {
    const target = await webhook(status, "redirect");
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: () => `PAY-REDIRECT-${status}`,
      verify: passingVerifier
    }).run({ scenario: "sequential-duplicate-webhook" });

    expect(result.passed).toBe(false);
    expect(target.requests).toHaveLength(2);
    expect(result.report.deliveries[0]?.status).toBe(status);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("unexpected-http-response");
  });

  it.each([401, 403])("classifies HTTP %s as an authentication or authorization failure", async (status) => {
    const target = await webhook(status, "not authorized");
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: () => `PAY-AUTH-${status}`,
      verify: passingVerifier
    }).run({ scenario: "sequential-duplicate-webhook" });

    expect(result.passed).toBe(false);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("authentication-failure");
  });

  it.each([404, 405, 408, 415])("classifies HTTP %s as an unexpected client response", async (status) => {
    const target = await webhook(status, "client error");
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: () => `PAY-CLIENT-${status}`,
      verify: passingVerifier
    }).run({ scenario: "sequential-duplicate-webhook" });

    expect(result.passed).toBe(false);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("unexpected-http-response");
  });

  it("classifies HTTP 429 as a rate-limiting failure", async () => {
    const target = await webhook(429, "slow down");
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: target.url,
      createPayment: () => "PAY-RATE-LIMIT",
      verify: passingVerifier
    }).run({ scenario: "sequential-duplicate-webhook" });

    expect(result.passed).toBe(false);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("rate-limit-failure");
  });

  it("classifies an unreachable endpoint separately from an HTTP response", async () => {
    const result = await new BachsProof({
      provider: provider(),
      webhookUrl: "http://127.0.0.1:1/unreachable",
      createPayment: () => "PAY-NETWORK-FAIL",
      verify: passingVerifier
    }).run({ scenario: "sequential-duplicate-webhook" });

    expect(result.passed).toBe(false);
    expect(result.report.deliveries[0]?.status).toBeUndefined();
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("network-failure");
    expect(result.report.financialOutcome).toBe("PASS");
  });

  it("keeps an allowed rejection separate from an unverified financial result", async () => {
    const target = await webhook(422, "rejected");
    const result = await new BachsProof({
      provider: plannedProvider(["2xx", 400, 409, 422], false),
      webhookUrl: target.url,
      createPayment: () => "PAY-REJECT-TIMEOUT",
      verify: () => ({
        reference: "PAY-REJECT-TIMEOUT",
        creditCount: 0,
        creditedAmountMinor: 0,
        currency: "NGN",
        pending: true,
        ledgerEntries: []
      }),
      financialVerification: { completionDeadlineMs: 10, pollIntervalMs: 1 }
    }).run({ scenario: "incorrect-payment-amount" });

    expect(result.passed).toBe(false);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("expected-rejection");
    expect(result.report.financialOutcome).toBe("UNVERIFIED");
  });

  it("fails financially when an allowed rejection still produces an unexpected credit", async () => {
    const target = await webhook(409, "duplicate");
    const result = await new BachsProof({
      provider: plannedProvider(["2xx", 400, 409, 422], false),
      webhookUrl: target.url,
      createPayment: () => "PAY-REJECT-CREDIT",
      verify: (reference) => ({
        reference,
        creditCount: 1,
        creditedAmountMinor: 500_000,
        currency: "NGN",
        ledgerEntries: [{ id: "credit-1", type: "payment", amountMinor: 500_000, currency: "NGN" }]
      })
    }).run({ scenario: "incorrect-payment-amount" });

    expect(result.passed).toBe(false);
    expect(result.report.deliveries[0]?.deliveryOutcome).toBe("expected-rejection");
    expect(result.report.financialOutcome).toBe("FAIL");
    expect(result.report.failureType).toBe("invariant-violation");
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
