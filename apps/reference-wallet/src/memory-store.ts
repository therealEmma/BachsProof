import { randomUUID } from "node:crypto";
import type { IncomingPayment, PaymentSnapshot, StateInspection, WalletStore } from "./types.js";

interface MemoryCredit {
  id: string;
  reference: string;
  amountMinor: number;
  amountScale: number;
  currency: string;
  type: string;
  idempotencyKey: string | null;
  eventId: string;
}

interface MemoryEvent {
  eventId: string;
  eventType: string;
  eventCreatedAt: string;
  reference?: string;
  providerPaymentId?: string;
  status: string;
}

/**
 * Small deterministic store used by fast tests when PostgreSQL is unavailable.
 * It is not presented as a substitute for the Prisma integration tests.
 */
export class InMemoryWalletStore implements WalletStore {
  private payments = new Map<string, PaymentSnapshot>();
  private credits: MemoryCredit[] = [];
  private balances = new Map<string, number>();
  private events = new Map<string, MemoryEvent>();

  async reset(): Promise<void> {
    this.payments.clear();
    this.credits = [];
    this.balances.clear();
    this.events.clear();
  }

  /** The in-memory store has no sockets, pools, or file handles to release. */
  async close(): Promise<void> {
    // The in-memory adapter has no external resources.
  }

  /** Remove only the selected synthetic references, preserving other test data. */
  async cleanupReferences(references: string[], customerIds: string[] = []): Promise<void> {
    const selected = new Set(references);
    const removedCustomers = new Set(customerIds);
    for (const payment of this.payments.values()) {
      if (selected.has(payment.reference)) removedCustomers.add(payment.customerId);
    }
    this.credits = this.credits.filter((credit) => !selected.has(credit.reference));
    for (const reference of selected) this.payments.delete(reference);
    for (const [eventId, event] of this.events) {
      if (event.reference && selected.has(event.reference)) this.events.delete(eventId);
    }
    for (const customerId of removedCustomers) {
      if (![...this.payments.values()].some((payment) => payment.customerId === customerId)) this.balances.delete(customerId);
    }
  }

  /** Create a pending row once; concurrent callers receive independent snapshots. */
  async ensurePendingPayment(payment: IncomingPayment): Promise<PaymentSnapshot> {
    const existing = this.payments.get(payment.reference);
    if (existing) {
      const comparisonScale = Math.max(existing.amountScale, payment.amountScale);
      const sameAmount = BigInt(existing.amountMinor) * 10n ** BigInt(comparisonScale - existing.amountScale)
        === BigInt(payment.amountMinor) * 10n ** BigInt(comparisonScale - payment.amountScale);
      if (existing.customerId !== payment.customerId || existing.currency !== payment.currency || !sameAmount) {
        throw new Error(`Payment ${payment.reference} does not match the existing order`);
      }
      if ((existing.providerPaymentId && payment.providerPaymentId && existing.providerPaymentId !== payment.providerPaymentId)
        || (existing.checkoutId && payment.checkoutId && existing.checkoutId !== payment.checkoutId)) {
        throw new Error(`Payment ${payment.reference} does not match the existing Bachs transaction`);
      }
      if (!existing.providerPaymentId && payment.providerPaymentId) existing.providerPaymentId = payment.providerPaymentId;
      if (!existing.checkoutId && payment.checkoutId) existing.checkoutId = payment.checkoutId;
      return { ...existing };
    }
    const snapshot: PaymentSnapshot = {
      id: randomUUID(),
      reference: payment.reference,
      customerId: payment.customerId,
      amountMinor: payment.amountMinor,
      amountScale: payment.amountScale,
      currency: payment.currency,
      status: "PENDING",
      providerPaymentId: payment.providerPaymentId,
      checkoutId: payment.checkoutId
    };
    this.payments.set(payment.reference, snapshot);
    this.balances.set(payment.customerId, this.balances.get(payment.customerId) ?? 0);
    return { ...snapshot };
  }

  /** Return a clone so one request cannot observe another request's later mutation. */
  async getPayment(reference: string): Promise<PaymentSnapshot | undefined> {
    const payment = this.payments.get(reference);
    return payment ? { ...payment } : undefined;
  }

  /**
   * Deliberately non-atomic check-then-credit flow. The checkpoint is placed
   * between the snapshot read and the credit write so two requests can both
   * commit a credit for one payment.
   */
  async processVulnerable(payment: IncomingPayment, afterCheck: () => Promise<void>): Promise<boolean> {
    const snapshot = await this.getPayment(payment.reference);
    if (!snapshot) throw new Error(`Payment ${payment.reference} was not initialized`);
    await afterCheck();
    if (!payment.eligible) {
      const current = this.payments.get(payment.reference);
      if (current && current.status !== "COMPLETED") current.status = payment.status;
      return false;
    }
    if (snapshot.status === "COMPLETED") return false;
    this.credits.push({
      id: randomUUID(),
      reference: payment.reference,
      amountMinor: payment.amountMinor,
      amountScale: payment.amountScale,
      currency: payment.currency,
      type: "CREDIT",
      idempotencyKey: null,
      eventId: payment.eventId
    });
    this.balances.set(payment.customerId, (this.balances.get(payment.customerId) ?? 0) + payment.amountMinor);
    const current = this.payments.get(payment.reference);
    if (current) current.status = "COMPLETED";
    return true;
  }

  /**
   * Test-store equivalent of a unique database constraint. The real Prisma
   * store relies on PostgreSQL's unique idempotency index inside a transaction.
   */
  async processCorrected(payment: IncomingPayment, afterCheck: () => Promise<void>): Promise<boolean> {
    const snapshot = await this.getPayment(payment.reference);
    if (!snapshot) throw new Error(`Payment ${payment.reference} was not initialized`);
    await afterCheck();
    // This synchronous critical section models the database's unique index and
    // transaction boundary. The PostgreSQL implementation below uses the real
    // unique constraint instead of this test-only lock.
    if (this.events.has(payment.eventId)) return false;
    this.events.set(payment.eventId, {
      eventId: payment.eventId,
      eventType: payment.eventType,
      eventCreatedAt: payment.eventCreatedAt,
      reference: payment.reference,
      providerPaymentId: payment.providerPaymentId,
      status: payment.status
    });
    const current = this.payments.get(payment.reference);
    const previousEventAt = current?.lastEventCreatedAt ? Date.parse(current.lastEventCreatedAt) : Number.NEGATIVE_INFINITY;
    const eventAt = Date.parse(payment.eventCreatedAt);
    if (!payment.eligible) {
      if (current && current.status !== "COMPLETED" && eventAt >= previousEventAt) {
        current.status = payment.status;
        current.lastEventCreatedAt = payment.eventCreatedAt;
      }
      return false;
    }
    if (snapshot.status === "COMPLETED" || this.credits.some((credit) => credit.idempotencyKey === payment.reference)) return false;
    this.credits.push({
      id: randomUUID(),
      reference: payment.reference,
      amountMinor: payment.amountMinor,
      amountScale: payment.amountScale,
      currency: payment.currency,
      type: "CREDIT",
      idempotencyKey: payment.reference,
      eventId: payment.eventId
    });
    this.balances.set(payment.customerId, (this.balances.get(payment.customerId) ?? 0) + payment.amountMinor);
    if (current) {
      current.status = "COMPLETED";
      current.lastEventCreatedAt = payment.eventCreatedAt;
    }
    return true;
  }

  async recordUnfulfillableEvent(input: MemoryEvent): Promise<boolean> {
    if (this.events.has(input.eventId)) return false;
    this.events.set(input.eventId, { ...input });
    return true;
  }

  /** Read committed credit rows rather than infer correctness from HTTP status. */
  async inspect(reference: string): Promise<StateInspection> {
    const payment = this.payments.get(reference);
    const credits = this.credits.filter((credit) => credit.reference === reference);
    return {
      reference,
      status: payment?.status ?? "NOT_FOUND",
      currency: payment?.currency ?? credits[0]?.currency ?? "",
      creditedAmountMinor: credits.reduce((total, credit) => total + credit.amountMinor, 0),
      creditCount: credits.length,
      walletBalanceMinor: payment ? this.balances.get(payment.customerId) ?? 0 : undefined,
      ledgerEntries: credits.map((credit) => ({
        id: credit.id,
        type: credit.type,
        amountMinor: credit.amountMinor,
        currency: credit.currency
      }))
    };
  }
}
