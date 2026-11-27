import { z } from "zod";
import type { FinancialVerificationContext, FinancialVerifier, ObservedPaymentState } from "./types.js";

/**
 * Runtime validation is important here because a malformed callback result
 * could otherwise make an incorrect financial state look like a passed test.
 */
export const financialVerificationSchema = z.object({
  reference: z.string().min(1),
  creditCount: z.number().int().nonnegative(),
  creditedAmountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: z.string().min(1).optional(),
  pending: z.boolean().optional(),
  ledgerEntries: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().length(3).optional()
  })).optional()
});

function formatPath(path: (string | number)[]): string {
  if (path.length === 0) return "the returned value";
  return path.reduce<string>((result, segment) => (
    typeof segment === "number" ? `${result}[${segment}]` : `${result}${result ? "." : ""}${segment}`
  ), "");
}

function formatCallbackError(error: unknown): Error {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue?.code === "invalid_type") {
      return new Error(
        `Financial verification callback returned invalid data at ${formatPath(issue.path)}: ` +
        `expected ${issue.expected}, received ${issue.received}`
      );
    }
    if (issue) {
      return new Error(`Financial verification callback returned invalid data at ${formatPath(issue.path)}: ${issue.message}`);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Financial verification")
    ? new Error(message)
    : new Error(`Financial verification failed: ${message}`);
}

/**
 * Convert the public callback shape into the core's normalized observation
 * shape. The default status keeps the callback API small while preserving the
 * status field used by the HTTP adapter and reports.
 */
export function normalizeCallbackState(value: unknown): ObservedPaymentState {
  const parsed = financialVerificationSchema.parse(value);
  return {
    reference: parsed.reference,
    status: parsed.status ?? "UNKNOWN",
    currency: parsed.currency,
    creditedAmountMinor: parsed.creditedAmountMinor,
    creditCount: parsed.creditCount,
    pending: parsed.pending,
    ledgerEntries: parsed.ledgerEntries ?? []
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
  let lastError: Error | undefined;
  let lastObserved: ObservedPaymentState | undefined;
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
      const candidate = formatCallbackError(error);
      // Callback exceptions and malformed callback values are configuration or
      // application errors, not asynchronous "not ready" state. Developers
      // should return pending: true while work is in flight so an unimplemented
      // verifier fails immediately instead of waiting through every poll.
      if (!candidate.message.startsWith("Financial verification timed out after ")) throw candidate;
      lastError = candidate;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const waitMs = Math.min(options.pollIntervalMs ?? 25, Math.max(1, deadline - Date.now()));
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (lastObserved && !lastObserved.pending) return lastObserved;
  throw lastError ?? new Error(`Financial verification timed out after ${timeoutMs}ms`);
}
