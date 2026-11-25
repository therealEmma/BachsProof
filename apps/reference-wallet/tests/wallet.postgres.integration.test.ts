import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PayProof } from "@payproof/core";
import { bachsAdapter } from "@payproof/bachs";
import { createReferenceWallet, PrismaWalletStore } from "../src/index.js";

/**
 * These tests are intentionally skipped, rather than faked, when Railway (or
 * another PostgreSQL) is not configured. A skipped test is an honest signal
 * that the database acceptance demonstration did not run.
 */
const databaseUrl = process.env.DATABASE_URL;
let databaseReady = false;
let databaseError = "";

if (!databaseUrl) {
  console.warn("[PayProof] PostgreSQL integration tests skipped: DATABASE_URL is not configured.");
}

describe("reference wallet against real PostgreSQL", () => {
  beforeAll(async () => {
    if (!databaseUrl) return;
    const probe = new PrismaWalletStore(databaseUrl);
    try {
      await probe.prisma.$connect();
      await probe.prisma.$queryRaw`SELECT 1`;
      databaseReady = true;
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
      console.warn(`[PayProof] PostgreSQL integration tests skipped: ${databaseError}`);
    } finally {
      await probe.close();
    }
  });

  afterAll(() => {
    if (!databaseReady && databaseError) {
      console.warn(`[PayProof] No PostgreSQL result was claimed: ${databaseError}`);
    }
  });

  it("detects duplicate committed PostgreSQL credits in the vulnerable handler", async (context) => {
    if (!databaseReady || !databaseUrl) {
      context.skip();
      return;
    }
    const result = await runScenario("vulnerable", databaseUrl);
    expect(result.passed).toBe(false);
    expect(result.report.observed?.creditCount).toBe(2);
    expect(result.report.verification?.violations.map((violation) => violation.id)).toContain("INV-001");
  }, 60_000);

  it("commits exactly one PostgreSQL credit in the corrected handler", async (context) => {
    if (!databaseReady || !databaseUrl) {
      context.skip();
      return;
    }
    const result = await runScenario("corrected", databaseUrl);
    expect(result.passed).toBe(true);
    expect(result.report.observed?.creditCount).toBe(1);
  }, 60_000);
});

/**
 * Start one isolated app/store pair. The unique reference and customer ID
 * make cleanup safe even when the Railway database is shared by a developer's
 * other PayProof runs.
 */
async function runScenario(mode: "vulnerable" | "corrected", url: string) {
  const store = new PrismaWalletStore(url);
  const reference = `PAY-PG-${randomUUID()}`;
  const customerId = `customer-pg-${randomUUID()}`;
  const wallet = await createReferenceWallet({
    mode,
    store,
    databaseUrl: url,
    testEnvironment: true
  });
  const server = createServer(wallet.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PostgreSQL reference wallet did not start");

  // This callback reads the committed PostgreSQL records directly. The HTTP
  // state endpoint is deliberately not configured in this demonstration.
  const payproof = new PayProof({
    provider: bachsAdapter({ mode: "mock", customerId }),
    target: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      webhookPath: "/webhooks/bachs",
    },
    verify: async (requestedReference) => {
      const credits = await store.prisma.walletCredit.findMany({ where: { reference: requestedReference } });
      return {
        reference: requestedReference,
        creditCount: credits.length,
        creditedAmountMinor: credits.reduce((sum, credit) => sum + Number(credit.amountMinor), 0),
        currency: credits[0]?.currency ?? "NGN"
      };
    },
    // A public Railway connection adds materially more round-trip latency than
    // the local in-memory suites; keep the barrier deterministic without
    // turning a slow but healthy database into a false checkpoint failure.
    checkpoint: { name: "after-idempotency-check", timeoutMs: 30_000 }
  });

  try {
    return await payproof.run({
      scenario: "concurrent-duplicate-credit",
      concurrency: 2,
      reference,
      amountMinor: 5_000_000,
      currency: "NGN"
    });
  } finally {
    await store.cleanupReferences([reference], [customerId]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await wallet.close();
  }
}
