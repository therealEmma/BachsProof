import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { BachsWebhookError, webhooks } from "@bachs/sdk";
import { createBachsMockFixture, normalizeBachsWebhookEvent, parseBachsWebhookEvent, type NormalizedBachsPayment } from "@bachsproof/bachs";
import { ZodError } from "zod";
import { InMemoryWalletStore } from "./memory-store.js";
import { PrismaWalletStore } from "./prisma-store.js";
import type { IncomingPayment, PaymentSnapshot, WalletStore } from "./types.js";

export interface ReferenceWalletOptions {
  mode: "vulnerable" | "corrected";
  store?: WalletStore;
  databaseUrl?: string;
  testEnvironment?: boolean;
  /** Bachs endpoint signing secret. The official SDK verifies the raw body. */
  bachsWebhookSecret?: string;
  /** Require signature verification even when no secret was supplied. */
  requireBachsSignature?: boolean;
}

export interface ReferenceWalletPaymentInput {
  reference?: string;
  amountMinor: number;
  currency: string;
  customerId?: string;
}

export interface ReferenceWallet {
  app: Express;
  store: WalletStore;
  /** Create a fresh pending payment for BachsProof's preparation callback. */
  createPayment(input: ReferenceWalletPaymentInput): Promise<PaymentSnapshot>;
  close(): Promise<void>;
}

function toIncomingPayment(normalized: NormalizedBachsPayment): IncomingPayment | undefined {
  if (!normalized.reference || normalized.amountMinor === undefined || normalized.amountScale === undefined || !normalized.currency || !normalized.customerId) {
    return undefined;
  }
  return {
    reference: normalized.reference,
    amountMinor: normalized.amountMinor,
    amountScale: normalized.amountScale,
    currency: normalized.currency,
    customerId: normalized.customerId,
    eligible: normalized.eligible,
    eventId: normalized.eventId,
    eventType: normalized.eventType,
    eventCreatedAt: normalized.eventCreatedAt,
    providerPaymentId: normalized.providerPaymentId,
    checkoutId: normalized.checkoutId,
    status: normalized.status
  };
}

function rawWebhookBody(req: Request): Buffer {
  if (!Buffer.isBuffer(req.body)) throw new Error("Bachs webhook body was not received as raw bytes");
  return req.body;
}

export async function createReferenceWallet(options: ReferenceWalletOptions): Promise<ReferenceWallet> {
  if (options.mode !== "vulnerable" && options.mode !== "corrected") throw new Error("Wallet mode must be vulnerable or corrected");
  if (options.requireBachsSignature === true && !options.bachsWebhookSecret) {
    throw new Error("requireBachsSignature requires bachsWebhookSecret");
  }

  const store = options.store ?? (options.databaseUrl ? new PrismaWalletStore(options.databaseUrl) : new InMemoryWalletStore());
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => res.json({ ok: true, mode: options.mode }));

  // This parser is deliberately route-local. The Bachs SDK must see the exact
  // bytes that arrived on the wire before any JSON parser or reserialization.
  app.post("/webhooks/bachs", express.raw({ type: ["application/json", "application/*+json"], limit: "64kb" }), async (req, res, next) => {
    try {
      const rawBody = rawWebhookBody(req);
      let verifiedEvent: unknown;
      if (options.bachsWebhookSecret) {
        verifiedEvent = webhooks.constructEvent(rawBody, req.headers, options.bachsWebhookSecret);
      } else {
        if (options.requireBachsSignature) throw new Error("Bachs webhook signature verification is not configured");
        verifiedEvent = JSON.parse(rawBody.toString("utf8")) as unknown;
      }

      const event = parseBachsWebhookEvent(verifiedEvent);
      const normalized = normalizeBachsWebhookEvent(event);
      const payment = toIncomingPayment(normalized);
      if (!payment) {
        await store.recordUnfulfillableEvent({
          eventId: normalized.eventId,
          eventType: normalized.eventType,
          eventCreatedAt: normalized.eventCreatedAt,
          reference: normalized.reference,
          providerPaymentId: normalized.providerPaymentId,
          status: normalized.status
        });
        res.status(202).json({ accepted: true, credited: false, reason: "non-fulfilling-or-unmatched-event" });
        return;
      }

      await store.ensurePendingPayment(payment);
      const afterCheck = async () => undefined;
      const credited = options.mode === "vulnerable"
        ? await store.processVulnerable(payment, afterCheck)
        : await store.processCorrected(payment, afterCheck);
      res.status(200).json({ accepted: true, credited });
    } catch (error) {
      if (error instanceof BachsWebhookError) {
        res.status(400).json({ error: "invalid-bachs-webhook" });
        return;
      }
      if (error instanceof SyntaxError || error instanceof ZodError) {
        res.status(400).json({ error: "invalid-bachs-webhook" });
        return;
      }
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: "invalid-request" });
      return;
    }
    const message = error instanceof Error ? error.message : "internal-error";
    res.status(500).json({ error: message });
  });

  return {
    app,
    store,
    async createPayment(input) {
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw new Error("Reference wallet amountMinor must be a non-negative safe integer");
      if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("Reference wallet currency must be a three-letter ISO currency code");
      const reference = input.reference ?? `PAY-TEST-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const event = createBachsMockFixture({ reference, amountMinor: input.amountMinor, currency: input.currency, customerId: input.customerId });
      const payment = toIncomingPayment(normalizeBachsWebhookEvent(event));
      if (!payment) throw new Error(`Could not prepare reference wallet payment ${reference}`);
      // Provider transaction identifiers are created by the simulated event,
      // not by this local preparation helper. Leave them empty so the first
      // authentic-looking webhook can attach its own identifiers.
      return store.ensurePendingPayment({ ...payment, providerPaymentId: undefined, checkoutId: undefined });
    },
    async close() {
      await store.close?.();
    }
  };
}

export { InMemoryWalletStore } from "./memory-store.js";
export { PrismaWalletStore } from "./prisma-store.js";
export type { IncomingPayment, PaymentSnapshot, StateInspection, WalletStore } from "./types.js";
