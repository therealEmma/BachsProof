import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PayProof } from "./orchestrator.js";
import type { PaymentEvent, ProviderAdapter } from "./types.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("PayProof concurrent duplicate delivery", () => {
  it("rejects missing real references before creating or delivering a webhook", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("unexpected");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test webhook server did not start");

    const provider: ProviderAdapter = {
      name: "reference-validation-provider",
      mode: "fixture",
      createPayment() {
        throw new Error("createPayment should not run before input validation");
      },
      serialize(event) {
        return JSON.stringify(event);
      },
      expectedState(event) {
        return { reference: event.reference, eligible: true, amountMinor: event.amountMinor, currency: event.currency, expectedCreditCount: 1 };
      }
    };

    const result = await new PayProof({
      provider,
      target: { baseUrl: `http://127.0.0.1:${address.port}`, webhookPath: "/webhooks/payment", reset: false }
    }).run({ scenario: "concurrent-duplicate-credit", concurrency: 2 });

    expect(result.passed).toBe(false);
    expect(result.report.errors[0]).toContain("real application reference is required");
    expect(result.report.deliveries).toEqual([]);
    expect(requests).toBe(0);
  });

  it("runs without a checkpoint and preserves every delivery error", async () => {
    let failDeliveries = false;
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.statusCode = failDeliveries ? 503 : 200;
        response.end(failDeliveries ? "temporarily unavailable" : "accepted");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test webhook server did not start");

    const provider: ProviderAdapter = {
      name: "regression-provider",
      mode: "fixture",
      createPayment(input = {}) {
        return {
          reference: input.reference ?? "PAY-CONCURRENT-NO-CHECKPOINT",
          amountMinor: input.amountMinor ?? 1_000,
          currency: input.currency ?? "NGN",
          status: "SUCCEEDED"
        };
      },
      serialize(event: PaymentEvent) {
        return JSON.stringify(event);
      },
      expectedState(event: PaymentEvent) {
        return {
          reference: event.reference,
          eligible: true,
          amountMinor: event.amountMinor,
          currency: event.currency,
          expectedCreditCount: 1
        };
      }
    };
    const payproof = new PayProof({
      provider,
      target: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        webhookPath: "/webhooks/payment",
        reset: false
      }
    });

    const successful = await payproof.run({
      scenario: "concurrent-duplicate-credit",
      concurrency: 3,
      reference: "PAY-CONCURRENT-NO-CHECKPOINT"
    });
    expect(successful.passed).toBe(true);
    expect(successful.report.replay.controlled).toBe(false);
    expect(successful.report.deliveries).toHaveLength(3);
    expect(new Set(bodies)).toHaveLength(1);

    failDeliveries = true;
    const failed = await payproof.run({
      scenario: "concurrent-duplicate-credit",
      concurrency: 3,
      reference: "PAY-CONCURRENT-ERRORS"
    });
    expect(failed.passed).toBe(false);
    expect(failed.report.replay.controlled).toBe(false);
    expect(failed.report.deliveries).toHaveLength(3);
    expect(failed.report.errors).toHaveLength(3);
    expect(failed.report.errors.every((error) => error.includes("Webhook delivery"))).toBe(true);
  });

  it("prepares missing references for single and concurrent-unique scenarios", async () => {
    let requests = 0;
    const contexts: Array<{ scenario: string; amountMinor: number; currency: string; paymentIndex: number; paymentCount: number }> = [];
    const server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = 200;
      response.end("accepted");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test webhook server did not start");

    const provider: ProviderAdapter = {
      name: "preparation-provider",
      mode: "fixture",
      createPayment(input = {}) {
        return {
          reference: input.reference ?? "PREPARED-FALLBACK",
          amountMinor: input.amountMinor ?? 2_500,
          currency: input.currency ?? "NGN",
          status: "SUCCEEDED"
        };
      },
      serialize(event) {
        return JSON.stringify(event);
      },
      expectedState(event) {
        return { reference: event.reference, eligible: true, amountMinor: event.amountMinor, currency: event.currency, expectedCreditCount: 1 };
      }
    };
    let nextReference = 1;
    const payproof = new PayProof({
      provider,
      target: { baseUrl: `http://127.0.0.1:${address.port}`, webhookPath: "/webhooks/payment", reset: false },
      createPayment: (context) => {
        contexts.push(context);
        return `PREPARED-${nextReference++}`;
      }
    });

    const single = await payproof.run({
      scenario: "sequential-duplicate-webhook",
      amountMinor: 7_500,
      currency: "USD"
    });
    const unique = await payproof.run({
      scenario: "concurrent-unique-payments",
      amountMinor: 8_500,
      currency: "EUR",
      concurrency: 2
    });

    expect(single.passed).toBe(true);
    expect(unique.passed).toBe(true);
    expect(contexts).toEqual([
      { scenario: "sequential-duplicate-webhook", amountMinor: 7_500, currency: "USD", paymentIndex: 0, paymentCount: 1 },
      { scenario: "concurrent-unique-payments", amountMinor: 8_500, currency: "EUR", paymentIndex: 0, paymentCount: 2 },
      { scenario: "concurrent-unique-payments", amountMinor: 8_500, currency: "EUR", paymentIndex: 1, paymentCount: 2 }
    ]);
    expect(requests).toBe(4);
  });

  it("does not deliver when payment preparation fails and preserves manual and synthetic modes", async () => {
    let requests = 0;
    let preparations = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = 200;
      response.end("accepted");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test webhook server did not start");

    const provider: ProviderAdapter = {
      name: "preparation-failure-provider",
      mode: "fixture",
      createPayment(input = {}) {
        return { reference: input.reference ?? "SYNTHETIC-REFERENCE", amountMinor: 1_000, currency: "NGN", status: "SUCCEEDED" };
      },
      serialize(event) { return JSON.stringify(event); },
      expectedState(event) { return { reference: event.reference, eligible: true, amountMinor: event.amountMinor, currency: event.currency, expectedCreditCount: 1 }; }
    };
    const payproof = new PayProof({
      provider,
      target: { baseUrl: `http://127.0.0.1:${address.port}`, webhookPath: "/webhooks/payment", reset: false },
      createPayment: () => {
        preparations += 1;
        throw new Error("test payment API unavailable");
      }
    });

    const failed = await payproof.run({ scenario: "sequential-duplicate-webhook" });
    const manual = await payproof.run({ scenario: "sequential-duplicate-webhook", reference: "MANUAL-001" });
    const synthetic = await payproof.run({ scenario: "sequential-duplicate-webhook", syntheticReferences: true });

    expect(failed.passed).toBe(false);
    expect(failed.report.errors[0]).toContain("Payment preparation failed");
    expect(failed.report.deliveries).toEqual([]);
    expect(manual.passed).toBe(true);
    expect(synthetic.passed).toBe(true);
    expect(preparations).toBe(1);
    expect(requests).toBe(4);
  });
});
