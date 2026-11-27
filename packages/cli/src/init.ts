import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const configTemplate = `/**
 * BachsProof test configuration.
 *
 * Required before a financially verified run:
 *   1. createPayment creates a fresh test payment or order;
 *   2. verify reads the committed payment and ledger state.
 *
 * These helpers are your test code. BachsProof does not add routes, inspect
 * arbitrary tables, or modify the production application.
 *
 * If this is a monorepo and your .env file is not loaded by the test command,
 * load it with the environment loader already used by your application before
 * reading process.env here.
 */
import { bachsAdapter } from "@bachsproof/cli";
import { tests } from "./tests/bachsproof.test.mjs";

const provider = bachsAdapter({ mode: "mock" });
const target = {
  baseUrl: process.env.BACHSPROOF_TARGET_URL ?? "http://127.0.0.1:3000",
  webhookPath: process.env.BACHSPROOF_WEBHOOK_PATH ?? "/webhooks/bachs"
};

const signingSecret = process.env.BACHS_WEBHOOK_SECRET;
const signing = signingSecret ? { type: "bachs", secret: signingSecret } : undefined;

// Required for real application references. Implement it first, then uncomment.
// import { createPayment } from "./tests/bachsproof.setup.mjs";

// Required for financial proof. It must read committed state, then uncomment.
// import { verify } from "./tests/bachsproof.verify.mjs";

export default {
  provider,
  target,
  ...(signing ? { signing } : {}),
  // createPayment,
  // verify,
  // Set this to true when CI must reject delivery-only results.
  // requireFinancialVerification: true,
  // financialVerification: {
  //   completionDeadlineMs: 10_000,
  //   pollIntervalMs: 25,
  //   negativeObservationWindowMs: 250
  // },
  tests
};
`;

const testTemplate = `/**
 * BachsProof scenarios.
 *
 * What each entry controls:
 *   - scenario selects the payment situation;
 *   - amountMinor is an integer minor-unit amount (500_000 NGN means ₦5,000);
 *   - currency selects the test currency;
 *   - expectedStatus is useful when the application should reject an event.
 *
 * Real application references are the default. Implement createPayment in
 * bachsproof.setup.mjs or add an explicit reference. Synthetic references are
 * only for isolated fixture tests and are not financial evidence.
 *
 * Run one: pnpm exec bachsproof test --name "sequential duplicate webhook"
 * Run all: pnpm exec bachsproof test
 */
const amountMinor = Number(process.env.BACHSPROOF_AMOUNT_MINOR ?? 500_000);
const currency = process.env.BACHSPROOF_CURRENCY ?? "NGN";
const syntheticReferences = process.env.BACHSPROOF_USE_SYNTHETIC_REFERENCES === "true";

export const tests = [
  // Same successful payment twice in sequence: tests idempotency.
  { name: "sequential duplicate webhook", scenario: "sequential-duplicate-webhook", amountMinor, currency, syntheticReferences },

  // Same successful payment concurrently: tests duplicate-credit races.
  { name: "concurrent duplicate credit", scenario: "concurrent-duplicate-credit", concurrency: 3, amountMinor, currency, syntheticReferences },

  // Distinct payments concurrently: tests cross-payment interference.
  { name: "concurrent unique payments", scenario: "concurrent-unique-payments", amountMinor, currency, syntheticReferences },

  // checkout.completed plus collection.succeeded for one payment.
  { name: "cross-event duplicate payment", scenario: "cross-event-duplicate-payment", amountMinor, currency, syntheticReferences },

  // Newer success followed by older expiry: tests state ordering.
  { name: "out-of-order events", scenario: "out-of-order-events", amountMinor, currency, syntheticReferences },

  // Expiry followed by delayed success: tests eventual payment confirmation.
  { name: "delayed payment confirmation", scenario: "delayed-payment-confirmation", delayMs: 50, amountMinor, currency, syntheticReferences },

  // Completed checkout without a collected payment: must not credit.
  { name: "incomplete checkout", scenario: "incomplete-checkout", amountMinor, currency, syntheticReferences },

  // Expired checkout: must not credit.
  { name: "expired checkout", scenario: "expired-checkout", amountMinor, currency, syntheticReferences },

  // Changed body after signing: normally expects a 4xx rejection.
  { name: "tampered webhook", scenario: "tampered-webhook", expectedStatus: "4xx", amountMinor, currency, syntheticReferences },

  // Invalid signature: normally expects a 4xx rejection.
  { name: "invalid webhook signature", scenario: "invalid-webhook-signature", expectedStatus: "4xx", amountMinor, currency, syntheticReferences },

  // Malformed JSON: normally expects a 4xx rejection.
  { name: "malformed webhook", scenario: "malformed-webhook", expectedStatus: "4xx", amountMinor, currency, syntheticReferences },

  // Successful-looking event with the wrong amount: must not credit.
  { name: "incorrect payment amount", scenario: "incorrect-payment-amount", amountMinor, currency, syntheticReferences },

  // Successful-looking event with the wrong currency: must not credit.
  { name: "incorrect payment currency", scenario: "incorrect-payment-currency", amountMinor, currency, syntheticReferences },

  // Underpaid collection: must not credit before the shortfall is paid.
  { name: "underpaid payment", scenario: "underpaid-payment", amountMinor, currency, syntheticReferences },

  // Failed collection: must not credit.
  { name: "failed payment", scenario: "failed-payment", amountMinor, currency, syntheticReferences }
];
`;

const setupTemplate = `/**
 * Create an isolated application payment record for BachsProof.
 *
 * This callback is optional only when every selected test already has a real
 * reference. It is recommended for a suite that you will run more than once.
 *
 * BachsProof calls it before a selected scenario needs a reference. Every call
 * must create a fresh test payment or order and return its reference. It must
 * not charge a card, call a live provider, or move real money.
 *
 * BachsProof passes five properties:
 *   - scenario: the named scenario currently running;
 *   - amountMinor: the integer amount expected by that scenario;
 *   - currency: the three-letter currency code;
 *   - paymentIndex: the zero-based payment number within this scenario;
 *   - paymentCount: the total number of payments this scenario needs.
 *
 * Use an existing isolated test API, application service, ORM, or seed helper.
 * The applicationTestApi name below is an example; BachsProof does not provide
 * it. Replace it with your own code.
 */
export async function createPayment({
  scenario,
  amountMinor,
  currency,
  paymentIndex,
  paymentCount
}) {
  throw new Error(
    "Implement createPayment in tests/bachsproof.setup.mjs. " +
    "Create an isolated test payment and return its fresh reference for " +
    scenario + " (" + (paymentIndex + 1) + " of " + paymentCount + ")."
  );

  // Replace applicationTestApi with your own test API, application service,
  // ORM, or database seeder. This helper is not provided by BachsProof.
  // const payment = await applicationTestApi.createPayment({
  //   scenario,
  //   amountMinor,
  //   currency,
  //   paymentIndex,
  //   paymentCount
  // });
  // if (!payment?.reference) throw new Error("payment API returned no reference");
  // return payment.reference;
}
`;

const verifierTemplate = `/**
 * Read the committed financial state for BachsProof.
 *
 * HTTP 200 only proves that the webhook route answered. This callback must
 * read the payment and actual credit or ledger records. Do not return hardcoded
 * expected values from the scenario configuration.
 *
 * Return the four required fields: reference, creditCount,
 * creditedAmountMinor, and currency. You may also return status, pending, and
 * ledgerEntries. Every ledger entry must contain id, type, and amountMinor;
 * currency is optional on an entry.
 */
export async function verify(reference, context) {
  throw new Error(
    "Implement verify in tests/bachsproof.verify.mjs by reading committed " +
    "financial records for " + reference + " before enabling it."
  );

  // Minimal valid response:
  // return { reference, creditCount: 0, creditedAmountMinor: 0, currency: "NGN" };
  //
  // Complete shape. Replace applicationTestApi with your own database or
  // ledger reader. This helper is not provided by BachsProof.
  // const state = await applicationTestApi.readCommittedFinancialState(reference);
  // const toSafeMinorUnits = (value) => {
  //   const number = typeof value === "bigint" ? Number(value) : Number(value);
  //   if (!Number.isSafeInteger(number)) throw new Error("Financial amount exceeds JavaScript safe integer range");
  //   return number;
  // };
  // return {
  //   reference,
  //   creditCount: state.credits.length,
  //   creditedAmountMinor: state.credits.reduce(
  //     (total, credit) => total + credit.amountMinor,
  //     0
  //   ),
  //   currency: state.currency,
  //   status: state.status,
  //   pending: state.pending,
  //   ledgerEntries: state.credits.map((credit) => ({
  //     id: String(credit.id),
  //     type: String(credit.type),
  //     amountMinor: toSafeMinorUnits(credit.amountMinor),
  //     currency: credit.currency
  //   }))
  // };
}
`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
export async function initProject(directory = process.cwd(), force = false): Promise<string[]> {
  const root = resolve(directory);
  const configPath = join(root, "bachsproof.config.mjs");
  const testDirectory = join(root, "tests");
  const testPath = join(testDirectory, "bachsproof.test.mjs");
  const setupPath = join(testDirectory, "bachsproof.setup.mjs");
  const verifierPath = join(testDirectory, "bachsproof.verify.mjs");
  const paths = [configPath, testPath, setupPath, verifierPath];
  if (!force) {
    const existing = [];
    for (const path of paths) if (await exists(path)) existing.push(path);
    if (existing.length > 0) {
      throw new Error("Refusing to overwrite existing BachsProof files: " + existing.join(", ") + ". Use --force to replace them.");
    }
  }
  await mkdir(testDirectory, { recursive: true });
  await writeFile(configPath, configTemplate, "utf8");
  await writeFile(testPath, testTemplate, "utf8");
  await writeFile(setupPath, setupTemplate, "utf8");
  await writeFile(verifierPath, verifierTemplate, "utf8");
  return paths;
}
