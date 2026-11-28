import type { PaymentReferenceCreator, RunOptions } from "./types.js";

const DEFAULT_AMOUNT_MINOR = 500_000;
const DEFAULT_CURRENCY = "NGN";

function hasReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function preparationError(scenario: RunOptions["scenario"], index: number, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Payment preparation failed for ${scenario} payment ${index + 1}: ${detail}`);
}

async function createReference(
  input: RunOptions,
  createPayment: PaymentReferenceCreator,
  paymentIndex: number,
  paymentCount: number
): Promise<string> {
  try {
    const reference = await createPayment({
      scenario: input.scenario,
      amountMinor: input.amountMinor ?? DEFAULT_AMOUNT_MINOR,
      currency: input.currency ?? DEFAULT_CURRENCY,
      paymentIndex,
      paymentCount
    });
    if (!hasReference(reference)) {
      throw new Error("createPayment must return a non-empty reference from the isolated test payment it created");
    }
    return reference.trim();
  } catch (error) {
    throw preparationError(input.scenario, paymentIndex, error);
  }
}

/** Prepare one fresh application payment for every logical payment in a run. */
export async function preparePaymentReferences(
  input: RunOptions,
  createPayment: PaymentReferenceCreator
): Promise<string[]> {
  const paymentCount = input.scenario === "concurrent-unique-payments" ? input.concurrency ?? 2 : 1;
  if (!Number.isInteger(paymentCount) || paymentCount < 1) {
    throw new Error("Payment preparation requires a positive payment count");
  }
  const references: string[] = [];
  for (let paymentIndex = 0; paymentIndex < paymentCount; paymentIndex += 1) {
    references.push(await createReference(input, createPayment, paymentIndex, paymentCount));
  }
  if (new Set(references).size !== references.length) {
    throw new Error(`Payment preparation failed for ${input.scenario}: createPayment returned duplicate payment references`);
  }
  return references;
}
