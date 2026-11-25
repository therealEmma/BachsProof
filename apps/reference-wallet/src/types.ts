/** A normalized payment extracted from the provider-specific webhook envelope. */
export interface IncomingPayment {
  reference: string;
  amountMinor: number;
  amountScale: number;
  currency: string;
  customerId: string;
  eligible: boolean;
  eventId: string;
  eventType: string;
  eventCreatedAt: string;
  providerPaymentId?: string;
  checkoutId?: string;
  status: string;
}

/** A database-independent view of a Payment row used by both stores. */
export interface PaymentSnapshot {
  id: string;
  reference: string;
  customerId: string;
  amountMinor: number;
  amountScale: number;
  currency: string;
  status: string;
  providerPaymentId?: string;
  checkoutId?: string;
  lastEventCreatedAt?: string;
}

/** The exact financial fields PayProof needs to evaluate its invariants. */
export interface StateInspection {
  reference: string;
  status: string;
  currency: string;
  creditedAmountMinor: number;
  creditCount: number;
  walletBalanceMinor?: number;
  ledgerEntries: Array<{
    id: string;
    type: string;
    amountMinor: number;
    currency: string;
  }>;
}

/**
 * Persistence boundary for the reference app. Keeping this small lets the
 * same Express handlers run against Prisma/PostgreSQL or the explicit local
 * in-memory test store.
 */
export interface WalletStore {
  ensurePendingPayment(payment: IncomingPayment): Promise<PaymentSnapshot>;
  getPayment(reference: string): Promise<PaymentSnapshot | undefined>;
  processVulnerable(payment: IncomingPayment, afterCheck: () => Promise<void>): Promise<boolean>;
  processCorrected(payment: IncomingPayment, afterCheck: () => Promise<void>): Promise<boolean>;
  recordUnfulfillableEvent(input: {
    eventId: string;
    eventType: string;
    eventCreatedAt: string;
    reference?: string;
    providerPaymentId?: string;
    status: string;
  }): Promise<boolean>;
  inspect(reference: string): Promise<StateInspection>;
  /** Remove only records belonging to the supplied test references/customers. */
  cleanupReferences?(references: string[], customerIds?: string[]): Promise<void>;
  close?(): Promise<void>;
}
