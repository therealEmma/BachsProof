import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BachsProof, type FinancialVerificationInput } from "@bachsproof/core";
import { bachsAdapter, createBachsScenario, normalizeBachsWebhookEvent, signBachsWebhook, type BachsPaymentEvent } from "./index.js";

const servers: Server[] = [];
const scenarios = [
  "sequential-duplicate-webhook",
  "concurrent-duplicate-credit",
  "concurrent-unique-payments",
  "cross-event-duplicate-payment",
  "out-of-order-events",
  "incomplete-checkout",
  "expired-checkout",
  "incorrect-payment-amount",
  "incorrect-payment-currency",
  "underpaid-payment",
  "failed-payment"
] as const;

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Bachs provider scenarios", () => {
  it("models checkout.completed without payment as a free completed checkout", () => {
    const plan = createBachsScenario("incomplete-checkout", {
      scenario: "incomplete-checkout",
      amountMinor: 5_000_000,
      currency: "NGN",
      reference: "CHECKOUT-FREE-001",
      references: ["CHECKOUT-FREE-001"]
    });
    const event = plan?.deliveries[0]?.event;
    expect(event).toBeDefined();
    const data = event?.data as Record<string, unknown>;
    expect(data.payment_status).toBe("no_payment_required");
    expect(data.amount).toBe("0");
    expect(data.charge).toBeNull();
    expect(data.completed_at).toBe(event?.created_at);
    expect(event?.providerPaymentId).toBe("");
    expect(normalizeBachsWebhookEvent(JSON.parse(JSON.stringify({
      id: event?.id,
      type: event?.type,
      created_at: event?.created_at,
      organization_id: event?.organization_id,
      data: event?.data
    })))).toMatchObject({ eligible: false, amountMinor: 0, providerPaymentId: undefined });
  });

  it("models an expired checkout with a past expiry and no provider charge", () => {
    const plan = createBachsScenario("expired-checkout", {
      scenario: "expired-checkout",
      amountMinor: 5_000_000,
      currency: "NGN",
      reference: "CHECKOUT-EXPIRED-001",
      references: ["CHECKOUT-EXPIRED-001"]
    });
    const event = plan?.deliveries[0]?.event;
    expect(event).toBeDefined();
    const data = event?.data as Record<string, unknown>;
    expect(data.status).toBe("expired");
    expect(data.payment_status).toBeNull();
    expect(data.charge).toBeNull();
    expect(data.completed_at).toBeNull();
    expect(Date.parse(String(data.expires_at))).toBeLessThan(Date.parse(event!.created_at));
    expect(event?.providerPaymentId).toBe("");
  });

  it("models underpaid as the documented crypto partial-payment event", () => {
    const plan = createBachsScenario("underpaid-payment", {
      scenario: "underpaid-payment",
      amountMinor: 5_000_000,
      currency: "NGN",
      reference: "UNDERPAID-001",
      references: ["UNDERPAID-001"]
    });
    const event = plan?.deliveries[0]?.event;
    expect(event?.type).toBe("collection.underpaid");
    expect(event?.data).toMatchObject({
      amount_paid: "25000.00",
      amount_expected: "50000.00",
      amount_remaining: "25000.00",
      currency: "NGN",
      status: "UNDERPAID"
    });
  });

  it.each(scenarios)("runs %s with signing and completed financial verification", async (scenario) => {
    const requests: Array<{ body: string; signature?: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ body, signature: request.headers["x-bachs-signature-v2"] as string | undefined });
        response.statusCode = 200;
        response.end("accepted");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("scenario server did not start");

    const baseProvider = bachsAdapter({ mode: "mock", customerId: `customer-${scenario}` });
    const provider = {
      ...baseProvider,
      headersForBody(event: BachsPaymentEvent, body: string | Uint8Array) {
        return { ...(baseProvider.headers?.(event) ?? {}), ...signBachsWebhook(body, "synthetic-test-secret") };
      }
    };
    const result = await new BachsProof({
      provider,
      webhookUrl: `http://127.0.0.1:${address.port}/webhooks/bachs`,
      createPayment: ({ paymentIndex }) => `BACHSPROOF-${scenario}-${paymentIndex}`,
      verify(reference, context): FinancialVerificationInput {
        const eligible = context?.expectedOutcome.eligible === true;
        return {
          reference,
          creditCount: eligible ? 1 : 0,
          creditedAmountMinor: eligible ? context?.expectedOutcome.amountMinor ?? 0 : 0,
          currency: context?.expectedOutcome.currency ?? "NGN",
          ledgerEntries: []
        };
      }
    }).run({ scenario, amountMinor: 5_000_000, currency: "NGN" });

    expect(result.passed).toBe(true);
    expect(result.report.financiallyVerified).toBe(true);
    expect(result.report.verification?.passed).toBe(true);
    expect(result.report.errors).toEqual([]);
    expect(requests.every((request) => request.signature?.startsWith("t=") && request.signature?.includes(",v1="))).toBe(true);
  });
});
