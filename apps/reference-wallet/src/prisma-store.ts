import { PrismaClient, Prisma } from "@prisma/client";
import type { IncomingPayment, PaymentSnapshot, StateInspection, WalletStore } from "./types.js";

/** Convert PostgreSQL BIGINT values without silently losing financial precision. */
function toNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Financial amount exceeds JavaScript safe integer range");
  return number;
}

function sameMoney(leftMinor: bigint, leftScale: number, rightMinor: number, rightScale: number): boolean {
  const scale = Math.max(leftScale, rightScale);
  return leftMinor * 10n ** BigInt(scale - leftScale) === BigInt(rightMinor) * 10n ** BigInt(scale - rightScale);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function snapshot(payment: {
  id: string;
  reference: string;
  customerId: string;
  amountMinor: bigint;
  amountScale: number;
  currency: string;
  status: string;
  providerPaymentId: string | null;
  checkoutId: string | null;
  lastEventCreatedAt: Date | null;
}): PaymentSnapshot {
  return {
    id: payment.id,
    reference: payment.reference,
    customerId: payment.customerId,
    amountMinor: toNumber(payment.amountMinor),
    amountScale: payment.amountScale,
    currency: payment.currency,
    status: payment.status,
    providerPaymentId: payment.providerPaymentId ?? undefined,
    checkoutId: payment.checkoutId ?? undefined,
    lastEventCreatedAt: payment.lastEventCreatedAt?.toISOString()
  };
}

const operationKey = (payment: IncomingPayment): string => `bachs:payment:${payment.reference}`;

/**
 * PostgreSQL persistence adapter. The vulnerable method is intentionally kept
 * for the portfolio demonstration; the corrected method is the production-
 * shaped path with durable event identity and one atomic ledger operation.
 */
export class PrismaWalletStore implements WalletStore {
  public readonly prisma: PrismaClient;

  constructor(databaseUrl?: string, prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
  }

  async reset(): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.webhookEvent.deleteMany(),
      this.prisma.walletCredit.deleteMany(),
      this.prisma.payment.deleteMany(),
      this.prisma.wallet.deleteMany()
    ]);
  }

  /**
   * Avoid Prisma's concurrent upsert race by doing find/create inside a short
   * transaction and retrying the unique-key loser. No application checkpoint
   * is held during this transaction.
   */
  async ensurePendingPayment(payment: IncomingPayment): Promise<PaymentSnapshot> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const existingWallet = await tx.wallet.findUnique({ where: { customerId: payment.customerId } });
          if (!existingWallet) {
            await tx.wallet.create({
              data: { customerId: payment.customerId, currency: payment.currency, balanceMinor: 0n }
            });
          } else if (existingWallet.currency !== payment.currency) {
            throw new Error(`Wallet currency mismatch for ${payment.customerId}`);
          }

          let existing = await tx.payment.findUnique({ where: { reference: payment.reference } });
          if (!existing) {
            existing = await tx.payment.create({
              data: {
                reference: payment.reference,
                customerId: payment.customerId,
                amountMinor: BigInt(payment.amountMinor),
                amountScale: payment.amountScale,
                currency: payment.currency,
                status: "PENDING",
                providerPaymentId: payment.providerPaymentId,
                checkoutId: payment.checkoutId
              }
            });
          } else {
            if (existing.customerId !== payment.customerId || existing.currency !== payment.currency || !sameMoney(existing.amountMinor, existing.amountScale, payment.amountMinor, payment.amountScale)) {
              throw new Error(`Payment ${payment.reference} does not match the existing order`);
            }
            if ((payment.providerPaymentId && existing.providerPaymentId && payment.providerPaymentId !== existing.providerPaymentId)
              || (payment.checkoutId && existing.checkoutId && payment.checkoutId !== existing.checkoutId)) {
              throw new Error(`Payment ${payment.reference} does not match the existing Bachs transaction`);
            }
            if ((!existing.providerPaymentId && payment.providerPaymentId) || (!existing.checkoutId && payment.checkoutId)) {
              existing = await tx.payment.update({
                where: { id: existing.id },
                data: {
                  providerPaymentId: existing.providerPaymentId ?? payment.providerPaymentId,
                  checkoutId: existing.checkoutId ?? payment.checkoutId
                }
              });
            }
          }
          return existing;
        }, { maxWait: 5_000, timeout: 10_000 });
        return snapshot(result);
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw new Error("Payment initialization retry limit reached");
  }

  async getPayment(reference: string): Promise<PaymentSnapshot | undefined> {
    const result = await this.prisma.payment.findUnique({ where: { reference } });
    return result ? snapshot(result) : undefined;
  }

  /** Deliberately unsafe handler used to prove the duplicate-credit race. */
  async processVulnerable(payment: IncomingPayment, afterCheck: () => Promise<void>): Promise<boolean> {
    const checked = await this.getPayment(payment.reference);
    if (!checked) throw new Error(`Payment ${payment.reference} was not initialized`);
    await afterCheck();
    if (!payment.eligible) {
      if (checked.status !== "COMPLETED") {
        await this.prisma.payment.update({ where: { reference: payment.reference }, data: { status: payment.status } });
      }
      return false;
    }
    if (checked.status === "COMPLETED") return false;
    const wallet = await this.prisma.wallet.findUniqueOrThrow({ where: { customerId: payment.customerId } });
    await this.prisma.walletCredit.create({
      data: {
        paymentId: checked.id,
        walletId: wallet.id,
        reference: payment.reference,
        amountMinor: BigInt(payment.amountMinor),
        amountScale: payment.amountScale,
        currency: payment.currency,
        type: "CREDIT",
        idempotencyKey: null,
        eventId: payment.eventId
      }
    });
    await this.prisma.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: { increment: BigInt(payment.amountMinor) } } });
    await this.prisma.payment.update({ where: { reference: payment.reference }, data: { status: "COMPLETED", lastEventCreatedAt: new Date(payment.eventCreatedAt), lastEventId: payment.eventId } });
    return true;
  }

  /**
   * The checkpoint is deliberately outside this transaction. The transaction
   * contains event deduplication, the unique business idempotency insert, the
   * balance increment, and payment completion as one commit unit.
   */
  async processCorrected(payment: IncomingPayment, afterCheck: () => Promise<void>): Promise<boolean> {
    const checked = await this.getPayment(payment.reference);
    if (!checked) throw new Error(`Payment ${payment.reference} was not initialized`);
    await afterCheck();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.payment.findUnique({ where: { reference: payment.reference } });
        if (!current) throw new Error(`Payment ${payment.reference} was not initialized`);
        if (current.customerId !== payment.customerId || current.currency !== payment.currency || !sameMoney(current.amountMinor, current.amountScale, payment.amountMinor, payment.amountScale)) {
          throw new Error(`Payment ${payment.reference} does not match the existing order`);
        }
        const existingEvent = await tx.webhookEvent.findUnique({ where: { eventId: payment.eventId } });
        if (existingEvent) return false;

        const event = await tx.webhookEvent.create({
          data: {
            eventId: payment.eventId,
            eventType: payment.eventType,
            eventCreatedAt: new Date(payment.eventCreatedAt),
            reference: payment.reference,
            providerPaymentId: payment.providerPaymentId,
            status: "RECEIVED",
            paymentId: current.id
          }
        });

        const eventAt = new Date(payment.eventCreatedAt).getTime();
        const previousEventAt = current.lastEventCreatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
        if (!payment.eligible) {
          if (current.status !== "COMPLETED" && eventAt >= previousEventAt) {
            await tx.payment.update({
              where: { id: current.id },
              data: { status: payment.status, lastEventCreatedAt: new Date(payment.eventCreatedAt), lastEventId: payment.eventId }
            });
          }
          await tx.webhookEvent.update({ where: { id: event.id }, data: { status: "IGNORED_NON_FULFILLING" } });
          return false;
        }

        if (current.status === "COMPLETED") {
          await tx.webhookEvent.update({ where: { id: event.id }, data: { status: "DUPLICATE_FINANCIAL_OPERATION" } });
          return false;
        }

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { customerId: payment.customerId } });
        const credit = await tx.walletCredit.createMany({
          data: [{
            paymentId: current.id,
            walletId: wallet.id,
            reference: payment.reference,
            amountMinor: BigInt(payment.amountMinor),
            amountScale: payment.amountScale,
            currency: payment.currency,
            type: "CREDIT",
            idempotencyKey: operationKey(payment),
            eventId: payment.eventId
          }],
          skipDuplicates: true
        });
        if (credit.count === 0) {
          await tx.webhookEvent.update({ where: { id: event.id }, data: { status: "DUPLICATE_FINANCIAL_OPERATION" } });
          return false;
        }
        await tx.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: { increment: BigInt(payment.amountMinor) } } });
        await tx.payment.update({
          where: { id: current.id },
          data: { status: "COMPLETED", lastEventCreatedAt: new Date(payment.eventCreatedAt), lastEventId: payment.eventId }
        });
        await tx.webhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED" } });
        return true;
      }, { maxWait: 5_000, timeout: 10_000 });
    } catch (error) {
      // A concurrent first-event insert can lose the event unique race before
      // the second transaction can see the committed row. Reconcile by reading
      // the durable event and return idempotently.
      if (isUniqueViolation(error)) {
        const event = await this.prisma.webhookEvent.findUnique({ where: { eventId: payment.eventId } });
        if (event) return false;
      }
      throw error;
    }
  }

  async recordUnfulfillableEvent(input: {
    eventId: string;
    eventType: string;
    eventCreatedAt: string;
    reference?: string;
    providerPaymentId?: string;
    status: string;
  }): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          eventId: input.eventId,
          eventType: input.eventType,
          eventCreatedAt: new Date(input.eventCreatedAt),
          reference: input.reference,
          providerPaymentId: input.providerPaymentId,
          status: input.status
        }
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async cleanupReferences(references: string[], customerIds: string[] = []): Promise<void> {
    const uniqueReferences = [...new Set(references)];
    if (uniqueReferences.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      const payments = await tx.payment.findMany({ where: { reference: { in: uniqueReferences } }, select: { customerId: true } });
      await tx.webhookEvent.deleteMany({ where: { reference: { in: uniqueReferences } } });
      await tx.walletCredit.deleteMany({ where: { reference: { in: uniqueReferences } } });
      await tx.payment.deleteMany({ where: { reference: { in: uniqueReferences } } });
      for (const customerId of [...new Set([...customerIds, ...payments.map((payment) => payment.customerId)])]) {
        const wallet = await tx.wallet.findUnique({ where: { customerId }, include: { credits: true } });
        if (wallet && wallet.credits.length === 0 && wallet.balanceMinor === 0n) {
          await tx.wallet.delete({ where: { id: wallet.id } });
        }
      }
    }, { maxWait: 10_000, timeout: 30_000 });
  }
  
  async inspect(reference: string): Promise<StateInspection> {
    const payment = await this.prisma.payment.findUnique({ where: { reference }, include: { credits: true } });
    if (!payment) return { reference, status: "NOT_FOUND", currency: "", creditedAmountMinor: 0, creditCount: 0, ledgerEntries: [] };
    const wallet = await this.prisma.wallet.findUnique({ where: { customerId: payment.customerId } });
    return {
      reference,
      status: payment.status,
      currency: payment.currency,
      creditedAmountMinor: payment.credits.reduce((total, credit) => total + toNumber(credit.amountMinor), 0),
      creditCount: payment.credits.length,
      walletBalanceMinor: wallet ? toNumber(wallet.balanceMinor) : undefined,
      ledgerEntries: payment.credits.map((credit) => ({
        id: credit.id,
        type: credit.type,
        amountMinor: toNumber(credit.amountMinor),
        currency: credit.currency
      }))
    };
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
