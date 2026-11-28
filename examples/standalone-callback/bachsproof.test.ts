import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { runConfig, type BachsProofConfig } from "@bachsproof/cli";

describe("standalone packaged callback integration", () => {
  it("uses the same two-callback configuration outside the monorepo", async () => {
    const credited = new Set<string>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data: { reference: string | null } };
        if (event.data.reference) credited.add(event.data.reference);
        response.statusCode = 200;
        response.end("accepted");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("standalone server did not start");
    const config: BachsProofConfig = {
      webhookUrl: `http://127.0.0.1:${address.port}/webhooks/bachs`,
      secret: "standalone-test-secret",
      amountMinor: 5_000_000,
      currency: "NGN",
      scenarios: ["sequential-duplicate-webhook"],
      createPayment: () => "PAY-PACKAGED",
      verify: (reference) => ({ reference, creditCount: credited.has(reference) ? 1 : 0, creditedAmountMinor: 5_000_000, currency: "NGN" })
    };
    try {
      const [run] = await runConfig(config);
      expect(run?.result.passed).toBe(true);
      expect(run?.result.report.financiallyVerified).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
