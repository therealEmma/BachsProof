import type { PaymentReferenceCreator, RunOptions } from "./types.js";

const DEFAULT_AMOUNT_MINOR = 5_000_000;
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
      throw new Error("createPayment must return a non-empty payment reference");
    }
    return reference.trim();
  } catch (error) {
    throw preparationError(input.scenario, paymentIndex, error);
  }
}

/**
 * Resolve missing application payment references before event creation. Manual
 * references take precedence, followed by the explicit synthetic fixture mode;
 * the application callback is used only when neither is supplied.
 */
export async function preparePaymentReferences(
  input: RunOptions,
  createPayment?: PaymentReferenceCreator
): Promise<RunOptions> {
  if (input.syntheticReferences) return input;

  if (input.scenario === "concurrent-unique-payments") {
    if (input.references) return input;
    if (!createPayment) return input;
    const paymentCount = input.concurrency ?? 2;
    const references: string[] = [];
    for (let paymentIndex = 0; paymentIndex < paymentCount; paymentIndex += 1) {
      references.push(await createReference(input, createPayment, paymentIndex, paymentCount));
    }
    return { ...input, references, concurrency: paymentCount };
  }

  if (hasReference(input.reference) || !createPayment) return input;
  return {
    ...input,
    reference: await createReference(input, createPayment, 0, 1)
  };
}
