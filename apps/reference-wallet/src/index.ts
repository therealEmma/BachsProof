import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { BachsWebhookError, webhooks } from "@bachs/sdk";
import { normalizeBachsWebhookEvent, parseBachsWebhookEvent, type NormalizedBachsPayment } from "@payproof/bachs";
import { checkpoint, checkpointMiddleware, configureCheckpoint } from "@payproof/sdk";
import { ZodError, z } from "zod";
import { InMemoryWalletStore } from "./memory-store.js";
import { PrismaWalletStore } from "./prisma-store.js";
import type { IncomingPayment, WalletStore } from "./types.js";

export interface ReferenceWalletOptions {
  mode: "vulnerable" | "corrected";
  store?: WalletStore;
  databaseUrl?: string;
  testEnvironment?: boolean;
  testSecret?: string;
  /** Bachs endpoint signing secret. The official SDK verifies the raw body. */
  bachsWebhookSecret?: string;
  /** Require signature verification even when no secret was supplied. */
  requireBachsSignature?: boolean;
  /** Required before the HTTP reset route may delete all rows. */
  allowDestructiveReset?: boolean;
}

export interface ReferenceWallet {
  app: Express;
  store: WalletStore;
  close(): Promise<void>;
}

/** Restrict state-management routes to an explicitly authorized test app. */
function testOnly(options: ReferenceWalletOptions): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (options.testEnvironment !== true) {
      res.status(404).json({ error: "test endpoints are disabled" });
      return;
    }
    if (!options.testSecret || req.header("x-payproof-test-secret") !== options.testSecret) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
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
  if (options.testEnvironment === true && !options.testSecret) {
    throw new Error("testEnvironment requires a non-empty testSecret");
  }
  if (options.requireBachsSignature === true && !options.bachsWebhookSecret) {
    throw new Error("requireBachsSignature requires bachsWebhookSecret");
  }

  const store = options.store ?? (options.databaseUrl ? new PrismaWalletStore(options.databaseUrl) : new InMemoryWalletStore());
  configureCheckpoint({ enabled: false, allowRequestHeaders: options.testEnvironment === true });
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => res.json({ ok: true, mode: options.mode }));

  // This parser is deliberately route-local. The Bachs SDK must see the exact
  // bytes that arrived on the wire before any JSON parser or reserialization.
  app.post("/webhooks/bachs", express.raw({ type: ["application/json", "application/*+json"], limit: "64kb" }), checkpointMiddleware({ enabled: options.testEnvironment === true, timeoutMs: 10_000 }) as express.RequestHandler, async (req, res, next) => {
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
      const afterCheck = () => checkpoint("after-idempotency-check", { key: payment.reference });
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

  // All other JSON routes can use the normal parser after the raw webhook route.
  app.use(express.json({ limit: "64kb" }));
  app.get("/__payproof/state", testOnly(options), async (req, res, next) => {
    try {
      const reference = z.string().min(1).parse(req.query.reference);
      res.json(await store.inspect(reference));
    } catch (error) {
      next(error);
    }
  });

  app.post("/__payproof/reset", testOnly(options), async (_req, res, next) => {
    try {
      const usesPostgres = store instanceof PrismaWalletStore;
      if (usesPostgres && options.allowDestructiveReset !== true) {
        res.status(409).json({ error: "destructive PostgreSQL reset requires allowDestructiveReset=true" });
        return;
      }
      await store.reset();
      res.status(204).send();
    } catch (error) {
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
    async close() {
      await store.close?.();
    }
  };
}

export { InMemoryWalletStore } from "./memory-store.js";
export { PrismaWalletStore } from "./prisma-store.js";
export type { IncomingPayment, PaymentSnapshot, StateInspection, WalletStore } from "./types.js";
