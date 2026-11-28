import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runConfig, summarizeRuns } from "./runner.js";
import type { BachsProofConfig } from "./types.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("CLI configuration runner", () => {
  it("runs the five standard scenarios by default and can select an optional scenario by name", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("accepted");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("default scenario server did not start");

    const config: BachsProofConfig = {
      webhookUrl: `http://127.0.0.1:${address.port}/webhooks/bachs`,
      secret: "test-secret",
      amountMinor: 1_250,
      currency: "NGN",
      createPayment: ({ scenario, paymentIndex }) => `DEFAULT-${scenario}-${paymentIndex}`,
      verify: (reference, context) => ({
        reference,
        creditCount: context?.expectedOutcome.expectedCreditCount ?? 0,
        creditedAmountMinor: context?.expectedOutcome.amountMinor ?? 0,
        currency: context?.expectedOutcome.currency ?? "NGN"
      })
    };

    const defaults = await runConfig(config);
    expect(defaults.map((result) => result.scenario)).toEqual([
      "sequential-duplicate-webhook",
      "concurrent-duplicate-credit",
      "concurrent-unique-payments",
      "incorrect-payment-amount",
      "incorrect-payment-currency"
    ]);
    const optional = await runConfig(config, { testName: "underpaid-payment" });
    expect(optional.map((result) => result.scenario)).toEqual(["underpaid-payment"]);
    expect(optional[0]?.result.passed).toBe(true);
  });

  it("uses the automatic Bachs adapter, signs requests, and runs selected scenarios", async () => {
    const requests: Array<{ body: string; signature?: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ body: Buffer.concat(chunks).toString("utf8"), signature: request.headers["x-bachs-signature-v2"] as string | undefined });
        response.end("accepted");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("runner server did not start");

    let count = 0;
    const config: BachsProofConfig = {
      webhookUrl: `http://127.0.0.1:${address.port}/webhooks/bachs`,
      secret: "test-secret",
      amountMinor: 1_250,
      currency: "NGN",
      scenarios: ["sequential-duplicate-webhook", "concurrent-unique-payments"],
      createPayment: ({ paymentIndex }) => `CLI-PAY-${count++}-${paymentIndex}`,
      verify: (reference, context) => ({
        reference,
        creditCount: context?.expectedOutcome.eligible ? 1 : 0,
        creditedAmountMinor: context?.expectedOutcome.eligible ? context.expectedOutcome.amountMinor : 0,
        currency: context?.expectedOutcome.currency ?? "NGN"
      })
    };

    const results = await runConfig(config);
    expect(results.map((result) => result.name)).toEqual(["Sequential duplicate webhook", "Concurrent unique payments"]);
    expect(results.every((result) => result.result.passed)).toBe(true);
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.signature?.includes(",v1=") === true)).toBe(true);
    expect(summarizeRuns(results)).toMatchObject({ total: 2, passed: 2, failed: 0, financiallyVerified: 2 });
  });

  it("rejects an unknown selected scenario name", async () => {
    const config: BachsProofConfig = {
      webhookUrl: "http://127.0.0.1:1/webhooks/bachs",
      secret: "test-secret",
      amountMinor: 1_250,
      currency: "NGN",
      scenarios: ["sequential-duplicate-webhook"],
      createPayment: () => "PAY-001",
      verify: () => ({ reference: "PAY-001", creditCount: 0, creditedAmountMinor: 0, currency: "NGN" })
    };
    await expect(runConfig(config, { testName: "not-a-scenario" })).rejects.toThrow("Unknown BachsProof scenario");
  });
});
