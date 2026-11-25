import { createServer, type Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { PayProof } from "@payproof/core";
import { bachsAdapter } from "@payproof/bachs";
import { createReferenceWallet, InMemoryWalletStore } from "../src/index.js";


async function runningWallet(mode: "vulnerable" | "corrected"): Promise<{ url: string; store: InMemoryWalletStore; server: Server; close: () => Promise<void> }> {
  const store = new InMemoryWalletStore();
  const wallet = await createReferenceWallet({ mode, store, testEnvironment: true });
  const server = createServer(wallet.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("wallet did not start");
  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await wallet.close();
    }
  };
}

const proof = (url: string, store: InMemoryWalletStore) => new PayProof({
  provider: bachsAdapter({ mode: "mock" }),
  target: { baseUrl: url, webhookPath: "/webhooks/bachs" },
  verify: async (reference) => store.inspect(reference),
  financialVerification: { completionDeadlineMs: 500, pollIntervalMs: 5 },
  checkpoint: { name: "after-idempotency-check", timeoutMs: 500 }
});

describe("reference wallet", () => {
  const resources: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (resources.length) await resources.pop()?.close();
  });

  it("fails the vulnerable wallet with a real duplicate persisted credit", async () => {
    const wallet = await runningWallet("vulnerable");
    resources.push(wallet);
    const result = await proof(wallet.url, wallet.store).run({ scenario: "concurrent-duplicate-credit", reference: "PAY-VULN" });
    expect(result.passed).toBe(false);
    expect(result.report.observed?.creditCount).toBe(2);
    expect(result.report.verification?.violations.map((violation) => violation.id)).toContain("INV-001");
    expect(result.report.checkpoints.filter((event) => event.type === "arrival")).toHaveLength(2);
  });

  it("passes the corrected wallet under the identical controlled schedule", async () => {
    const wallet = await runningWallet("corrected");
    resources.push(wallet);
    const result = await proof(wallet.url, wallet.store).run({ scenario: "concurrent-duplicate-credit", reference: "PAY-CORRECT" });
    expect(result.passed).toBe(true);
    expect(result.report.observed?.creditCount).toBe(1);
  });

  it("passes sequential duplicate delivery and supports replay", async () => {
    const wallet = await runningWallet("corrected");
    resources.push(wallet);
    const payproof = proof(wallet.url, wallet.store);
    const result = await payproof.run({ scenario: "sequential-duplicate-webhook", reference: "PAY-SEQUENTIAL" });
    expect(result.passed).toBe(true);
    const replay = await payproof.replay(result.report);
    expect(replay.passed).toBe(true);
    expect(replay.report.observed?.creditCount).toBe(1);
  });

  it("supports callback verification without configuring an HTTP state endpoint", async () => {
    const store = new InMemoryWalletStore();
    const wallet = await createReferenceWallet({ mode: "corrected", store, testEnvironment: true });
    const server = createServer(wallet.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("wallet did not start");
    resources.push({
      close: async () => {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await wallet.close();
      }
    });

    const payproof = new PayProof({
      provider: bachsAdapter({ mode: "mock" }),
      target: { baseUrl: `http://127.0.0.1:${address.port}`, webhookPath: "/webhooks/bachs" },
      verify: async (reference) => store.inspect(reference),
      checkpoint: { name: "after-idempotency-check", timeoutMs: 500 }
    });
    const result = await payproof.run({ scenario: "concurrent-duplicate-credit", reference: "PAY-CALLBACK" });
    expect(result.passed).toBe(true);
    expect(result.report.verificationMode).toBe("callback");
    expect(result.report.financiallyVerified).toBe(true);
  });
});
