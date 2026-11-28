import type { FinancialVerificationContext, FinancialVerifier, MinorUnitValue, ObservedPaymentState } from "./types.js";

const INTEGER = /^(?:0|[1-9]\d*)$/;

function safeMinorUnits(value: MinorUnitValue, path: string): number {
  let normalized: bigint;
  if (typeof value === "bigint") {
    normalized = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Financial verification callback returned invalid data at ${path}: expected a non-negative safe integer`);
    }
    return value;
  } else if (typeof value === "string" && INTEGER.test(value)) {
    normalized = BigInt(value);
  } else {
    throw new Error(`Financial verification callback returned invalid data at ${path}: expected a non-negative integer minor-unit amount`);
  }
  if (normalized < 0n || normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Financial verification callback returned invalid data at ${path}: amount exceeds JavaScript safe integer range`);
  }
  return Number(normalized);
}

function callbackError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Financial verification")
    ? new Error(message)
    : new Error(`Financial verification failed: ${message}`);
}

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Financial verification callback returned invalid data: expected an object");
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Financial verification callback returned invalid data at ${path}: expected a non-empty string`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Financial verification callback returned invalid data at ${path}: expected boolean`);
  }
  return value;
}

/**
 * Normalize the callback contract without converting monetary values through
 * floating-point arithmetic. BigInt and integer database strings are accepted
 * when they fit inside JavaScript's safe integer range.
 */
export function normalizeCallbackState(value: unknown): ObservedPaymentState {
  assertObject(value);
  const reference = requiredString(value.reference, "reference");
  if (!Number.isSafeInteger(value.creditCount) || (value.creditCount as number) < 0) {
    throw new Error("Financial verification callback returned invalid data at creditCount: expected a non-negative safe integer");
  }
  const currency = requiredString(value.currency, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Financial verification callback returned invalid data at currency: expected a three-letter ISO currency");
  }
  const ledgerEntries: ObservedPaymentState["ledgerEntries"] = [];
  if (value.ledgerEntries !== undefined) {
    if (!Array.isArray(value.ledgerEntries)) {
      throw new Error("Financial verification callback returned invalid data at ledgerEntries: expected an array");
    }
    for (const [index, entryValue] of value.ledgerEntries.entries()) {
      assertObject(entryValue);
      ledgerEntries.push({
        id: requiredString(entryValue.id, `ledgerEntries[${index}].id`),
        type: requiredString(entryValue.type, `ledgerEntries[${index}].type`),
        amountMinor: safeMinorUnits(entryValue.amountMinor as MinorUnitValue, `ledgerEntries[${index}].amountMinor`),
        ...(entryValue.currency === undefined ? {} : { currency: requiredString(entryValue.currency, `ledgerEntries[${index}].currency`).toUpperCase() })
      });
    }
  }
  return {
    reference,
    status: value.status === undefined ? "UNKNOWN" : requiredString(value.status, "status"),
    currency,
    creditedAmountMinor: safeMinorUnits(value.creditedAmountMinor as MinorUnitValue, "creditedAmountMinor"),
    creditCount: value.creditCount as number,
    ...(value.pending === undefined ? {} : { pending: optionalBoolean(value.pending, "pending") }),
    ledgerEntries
  };
}

export interface FinancialVerificationWaitOptions {
  pollIntervalMs?: number;
  /** Return only when the independently observed state is complete. */
  isComplete?: (state: ObservedPaymentState) => boolean;
}

/**
 * Execute a callback with a hard upper bound. JavaScript cannot forcibly stop
 * arbitrary user code, but the runner will stop waiting and report a timeout.
 */
export async function verifyWithCallback(
  verify: FinancialVerifier,
  reference: string,
  timeoutMs: number,
  context?: FinancialVerificationContext,
  options: FinancialVerificationWaitOptions = {}
): Promise<ObservedPaymentState> {
  const deadline = Date.now() + timeoutMs;
  let lastObserved: ObservedPaymentState | undefined;
  let lastTimeout: Error | undefined;
  while (Date.now() <= deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Financial verification timed out after ${timeoutMs}ms`)), remaining);
      });
      const value = await Promise.race([Promise.resolve().then(() => verify(reference, context)), timeout]);
      const normalized = normalizeCallbackState(value);
      if (normalized.reference !== reference) {
        throw new Error(`Financial verification returned ${normalized.reference} while ${reference} was requested`);
      }
      lastObserved = normalized;
      if (!options.isComplete || options.isComplete(normalized)) return normalized;
    } catch (error) {
      const candidate = callbackError(error);
      if (!candidate.message.startsWith("Financial verification timed out after ")) throw candidate;
      lastTimeout = candidate;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const waitMs = Math.min(options.pollIntervalMs ?? 25, Math.max(1, deadline - Date.now()));
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  // A non-pending final state is usable evidence even if it violates a rule;
  // the invariant evaluator will report that violation instead of hiding it as
  // a timeout. A pending state is not a completed financial verification.
  if (lastObserved && !lastObserved.pending) return lastObserved;
  throw lastTimeout ?? new Error(`Financial verification timed out after ${timeoutMs}ms`);
}
