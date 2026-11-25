import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBachsMockFixture,
  parseBachsWebhookEvent,
  parseBachsMoney,
  serializeBachsPaymentEvent,
  toBachsMinorUnits
} from "@payproof/bachs";
import { createReferenceWallet, InMemoryWalletStore } from "../src/index.js";

const WEBHOOK_SECRET = "whsec_payproof_test";

interface RunningWallet {
  url: string;
  store: InMemoryWalletStore;
  server: Server;
  close: () => Promise<void>;
}

async function runningWallet(options: { signature?: boolean } = {}): Promise<RunningWallet> {
  const store = new InMemoryWalletStore();
  const wallet = await createReferenceWallet({
    mode: "corrected",
    store,
    testEnvironment: true,
    bachsWebhookSecret: options.signature ? WEBHOOK_SECRET : undefined
  });
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

function signedHeaders(rawBody: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const digest = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return {
    "content-type": "application/json",
    "x-bachs-signature-v2": `t=${timestamp},v1=${digest}`
  };
}

async function post(wallet: RunningWallet, rawBody: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${wallet.url}/webhooks/bachs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody
  });
}

function completedCheckoutFrom(collection: ReturnType<typeof createBachsMockFixture>, createdAt: string) {
  return {
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type: "checkout.completed" as const,
    created_at: createdAt,
    organization_id: collection.organization_id,
    data: {
      checkout_id: collection.checkoutId,
      status: "completed",
      mode: "payment",
      payment_status: "paid",
      amount: collection.data.amount,
      currency: collection.data.currency,
      reference: collection.reference,
      customer: { customer_id: collection.customerId, email: "synthetic@example.com", name: "Synthetic Customer" },
      charge: { id: collection.providerPaymentId, status: "succeeded" },
      subscription: null,
      success_url: null,
      cancel_url: null,
      metadata: { order_id: collection.reference },
      completed_at: createdAt,
      expires_at: null,
      created_at: createdAt
    }
  };
}

function expiredCheckoutFrom(collection: ReturnType<typeof createBachsMockFixture>, createdAt: string) {
  return {
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type: "checkout.expired" as const,
    created_at: createdAt,
    organization_id: collection.organization_id,
    data: {
      checkout_id: collection.checkoutId,
      status: "expired",
      mode: "payment",
      payment_status: null,
      amount: collection.data.amount,
      currency: collection.data.currency,
      reference: collection.reference,
      customer: { customer_id: collection.customerId, email: "synthetic@example.com", name: "Synthetic Customer" },
      charge: null,
      subscription: null,
      success_url: null,
      cancel_url: null,
      metadata: { order_id: collection.reference },
      completed_at: null,
      expires_at: createdAt,
      created_at: createdAt
    }
  };
}

describe("Bachs-native reference wallet", () => {
  const resources: RunningWallet[] = [];
  afterEach(async () => {
    while (resources.length) await resources.pop()?.close();
  });

  it("parses decimal strings with exact arithmetic and verifies raw-body signatures", async () => {
    const exact = parseBachsMoney("50000.00", "NGN");
    expect(toBachsMinorUnits(exact, 2)).toBe(5_000_000n);

    const wallet = await runningWallet({ signature: true });
    resources.push(wallet);
    const event = createBachsMockFixture({ reference: "PAY-SIGNED" });
    const rawBody = JSON.stringify(JSON.parse(serializeBachsPaymentEvent(event)), null, 2);
    const accepted = await post(wallet, rawBody, signedHeaders(rawBody));
    expect(accepted.status).toBe(200);
    expect((await wallet.store.inspect(event.reference)).creditCount).toBe(1);

    const tampered = await post(wallet, `${rawBody} `, signedHeaders(rawBody));
    expect(tampered.status).toBe(400);
  });

  it("deduplicates checkout.completed and collection.succeeded for one charge", async () => {
    const wallet = await runningWallet();
    resources.push(wallet);
    const collection = createBachsMockFixture({ reference: "PAY-EVENT-PAIR" });
    const collectionRaw = serializeBachsPaymentEvent(collection);
    const checkout = completedCheckoutFrom(collection, new Date(Date.now() + 1_000).toISOString());
    const checkoutRaw = JSON.stringify(checkout);

    const responses = await Promise.all([post(wallet, collectionRaw), post(wallet, checkoutRaw)]);
    expect(responses.every((response) => response.ok)).toBe(true);
    const observed = await wallet.store.inspect(collection.reference);
    expect(observed.creditCount).toBe(1);
    expect(observed.creditedAmountMinor).toBe(5_000_000);
  });

  it("does not fulfil incomplete delivery, then accepts a later success without older-state regression", async () => {
    const wallet = await runningWallet();
    resources.push(wallet);
    const collection = createBachsMockFixture({ reference: "PAY-DELAYED" });
    const older = new Date(Date.now() - 2_000).toISOString();
    const newer = new Date(Date.now() + 2_000).toISOString();
    const expired = expiredCheckoutFrom(collection, older);

    const incomplete = await post(wallet, JSON.stringify(expired));
    expect(incomplete.status).toBe(200);
    expect((await wallet.store.inspect(collection.reference)).creditCount).toBe(0);

    const success = { ...collection, created_at: newer };
    const accepted = await post(wallet, serializeBachsPaymentEvent(success));
    expect(accepted.status).toBe(200);
    const afterSuccess = await wallet.store.inspect(collection.reference);
    expect(afterSuccess.creditCount).toBe(1);

    const delayedOlderEvent = { ...expired, id: `evt_${randomUUID().replaceAll("-", "")}` };
    const delayed = await post(wallet, JSON.stringify(delayedOlderEvent));
    expect(delayed.status).toBe(200);
    const final = await wallet.store.inspect(collection.reference);
    expect(final.status).toBe("COMPLETED");
    expect(final.creditCount).toBe(1);
  });

  it("returns 400 for malformed webhook JSON and exposes no inspection route", async () => {
    const wallet = await runningWallet();
    resources.push(wallet);
    expect((await post(wallet, "{not-json")).status).toBe(400);
    expect((await fetch(`${wallet.url}/__payproof/state?reference=PAY-NONE`)).status).toBe(404);
  });

  it("recognizes the documented event envelope before adapter normalization", () => {
    const event = createBachsMockFixture({ reference: "PAY-SCHEMA" });
    const parsed = parseBachsWebhookEvent(JSON.parse(serializeBachsPaymentEvent(event)));
    expect(parsed.type).toBe("collection.succeeded");
    expect(parsed.data.amount).toBe("50000.00");
  });
});
