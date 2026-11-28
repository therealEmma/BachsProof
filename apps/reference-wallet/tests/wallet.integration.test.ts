import { createServer, type Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { BachsProof } from "@bachsproof/core";
import { bachsAdapter } from "@bachsproof/bachs";
import { createReferenceWallet, InMemoryWalletStore } from "../src/index.js";

async function runningWallet(mode: "vulnerable" | "corrected") {
  const store = new InMemoryWalletStore();
  const wallet = await createReferenceWallet({ mode, store, testEnvironment: true });
  const server = createServer(wallet.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("wallet did not start");
  return {
    url: `http://127.0.0.1:${address.port}/webhooks/bachs`,
    store,
    wallet,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await wallet.close();
    }
  };
}

function proof(wallet: Awaited<ReturnType<typeof runningWallet>>) {
  return new BachsProof({
    provider: bachsAdapter({ mode: "mock" }),
    webhookUrl: wallet.url,
    createPayment: async ({ amountMinor, currency }) => (await wallet.wallet.createPayment({ amountMinor, currency })).reference,
    verify: async (reference) => wallet.store.inspect(reference),
    financialVerification: { completionDeadlineMs: 500, pollIntervalMs: 5 }
  });
}

describe("reference wallet", () => {
  const resources: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (resources.length) await resources.pop()?.close();
  });

  it("reports the vulnerable wallet's ordinary-concurrency outcome honestly", async () => {
    const wallet = await runningWallet("vulnerable");
    resources.push(wallet);
    const result = await proof(wallet).run({ scenario: "concurrent-duplicate-credit" });
    expect(result.report.financiallyVerified).toBe(true);
    if (!result.passed) {
      expect(result.report.observed?.creditCount).toBeGreaterThan(1);
      expect(result.report.verification?.violations.map((violation) => violation.id)).toContain("INV-001");
    } else {
      expect(result.report.observed?.creditCount).toBe(1);
    }
  });

  it("passes the corrected wallet with ordinary concurrent delivery", async () => {
    const wallet = await runningWallet("corrected");
    resources.push(wallet);
    const result = await proof(wallet).run({ scenario: "concurrent-duplicate-credit" });
    expect(result.passed).toBe(true);
    expect(result.report.observed?.creditCount).toBe(1);
  });

  it("passes sequential duplicate delivery with one committed credit", async () => {
    const wallet = await runningWallet("corrected");
    resources.push(wallet);
    const result = await proof(wallet).run({ scenario: "sequential-duplicate-webhook" });
    expect(result.passed).toBe(true);
    expect(result.report.observed?.creditCount).toBe(1);
  });

  it("prepares distinct records for concurrent unique payments", async () => {
    const wallet = await runningWallet("corrected");
    resources.push(wallet);
    const result = await proof(wallet).run({ scenario: "concurrent-unique-payments" });
    expect(result.passed).toBe(true);
    expect(result.report.payments).toHaveLength(2);
    expect(new Set(result.report.payments?.map((payment) => payment.event.reference)).size).toBe(2);
  });
});
