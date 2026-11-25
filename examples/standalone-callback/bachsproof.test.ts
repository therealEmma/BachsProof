import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { BachsProof } from "@bachsproof/core";
import { bachsAdapter } from "@bachsproof/bachs";

/**
 * A tiny application-shaped test double. The important point is that BachsProof
 * is imported from package archives and receives financial state through a
 * callback, exactly as an application test could do with Prisma.
 */
describe("standalone packaged callback integration", () => {
  it("imports package archives and verifies state without an HTTP state route", async () => {
    const credits = new Map<string, number>();
    const app = async (request: { method?: string; url?: string; on: (event: string, callback: (chunk: Buffer) => void) => void }, response: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void }) => {
      if (request.method !== "POST" || request.url !== "/webhooks/bachs") {
        response.statusCode = 404;
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data: { reference: string | null } };
        const reference = event.data.reference;
        if (reference) credits.set(reference, (credits.get(reference) ?? 0) + 1);
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ accepted: true }));
      });
    };
    const server = createServer(app as never);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("standalone server did not start");
    const bachsproof = new BachsProof({
      provider: bachsAdapter({ mode: "mock" }),
      target: { baseUrl: `http://127.0.0.1:${address.port}`, webhookPath: "/webhooks/bachs" },
      verify: async (reference) => ({
        reference,
        creditCount: credits.get(reference) ?? 0,
        creditedAmountMinor: (credits.get(reference) ?? 0) * 5_000_000,
        currency: "NGN"
      })
    });
    try {
      const result = await bachsproof.run({ scenario: "sequential-duplicate-webhook", reference: "PAY-PACKAGED" });
      expect(result.passed).toBe(false);
      expect(result.report.verificationMode).toBe("callback");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
