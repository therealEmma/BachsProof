import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const configTemplate = `/**
 * PayProof sends test payment webhooks to your application and checks how the
 * application handles them. This file tells PayProof where to send the test
 * and which optional helpers your test environment provides.
 *
 * Start here, then follow the numbered steps in this file.
 */
import { bachsAdapter } from "@payproof/cli";
import { tests } from "./tests/payproof.test.mjs";

// STEP 1: Select your payment provider.
//
// The built-in adapter creates documented-shaped Bachs test events locally.
// It does not call Bachs or move real money. Use it only with an isolated test
// application. A custom provider adapter can be used instead when needed.
const provider = bachsAdapter({ mode: "mock" });

// STEP 2: Tell PayProof where your application is running.
//
// baseUrl is the application address: http://127.0.0.1:3000
// webhookPath is the path handled by your webhook route: /webhooks/bachs
// Together they make this complete URL:
// http://127.0.0.1:3000/webhooks/bachs
//
// reset: false means your application owns test-data isolation. PayProof will
// not call a reset route or delete application data.
const target = {
  baseUrl: process.env.PAYPROOF_TARGET_URL ?? "http://127.0.0.1:3000",
  webhookPath: process.env.PAYPROOF_WEBHOOK_PATH ?? "/webhooks/bachs",
  reset: false
};

// STEP 3: Configure your webhook signing secret.
//
// Set BACHS_WEBHOOK_SECRET to the same test-only secret that your application
// uses to verify Bachs webhooks. PayProof signs the exact raw request body.
// Leave the variable unset only when your isolated test route does not verify
// signatures.
const signingSecret = process.env.BACHS_WEBHOOK_SECRET;
const signing = signingSecret
  ? { type: "bachs", secret: signingSecret }
  : undefined;

// STEP 4: Enable automatic test payment preparation.
//
// Open tests/payproof.setup.mjs and implement createPayment once. It creates
// fresh test records and returns their references. PayProof reuses that helper
// for every applicable scenario. Uncomment these two lines after implementing it.
// import { createPayment } from "./tests/payproof.setup.mjs";
// const paymentPreparation = createPayment;

// STEP 5: Enable financial verification.
//
// A successful HTTP response only says that your route accepted a webhook. It
// does not prove that the customer was credited correctly. Open
// tests/payproof.verify.mjs and connect verify to your committed test data.
// Uncomment all three lines after implementing it.
// import { verify } from "./tests/payproof.verify.mjs";
// const financialVerification = verify;
// const requireFinancialVerification = true;

// STEP 6: Select your payment tests.
//
// The generated file contains all 15 supported scenarios. Run one with
// \`pnpm exec payproof test --name "sequential duplicate webhook"\` or run all
// of them with \`pnpm exec payproof test\`.
export default {
  provider,
  target,
  ...(signing ? { signing } : {}),
  // createPayment: paymentPreparation,
  // verify: financialVerification,
  // requireFinancialVerification,
  tests
};
`;

const testTemplate = `/**
 * PayProof test scenarios
 *
 * A scenario is one payment-handling situation. When you run a scenario,
 * PayProof creates a documented test event, signs it when configured, sends it
 * to your webhook, and records the HTTP response. If you enable verify, it
 * also reads the financial records your application actually committed.
 *
 * Change amountMinor to change the test amount. Amounts are minor units: with
 * two decimal places, 500000 means ₦5,000. Change currency to the ISO currency
 * code your test application uses. Change concurrency only where shown.
 *
 * Start with one test:
 *   pnpm exec payproof test --name "sequential duplicate webhook"
 * Run every test:
 *   pnpm exec payproof test
 *
 * Real application references are the default. Enable createPayment in
 * payproof.config.mjs to create fresh records automatically. Synthetic
 * references are only for isolated fixture testing.
 */
const amountMinor = Number(process.env.PAYPROOF_AMOUNT_MINOR ?? 5_000_000);
const currency = process.env.PAYPROOF_CURRENCY ?? "NGN";
const syntheticReferences = process.env.PAYPROOF_USE_SYNTHETIC_REFERENCES === "true";

export const tests = [
  // PayProof sends the same successful payment webhook twice in order.
  // Your application should create only one customer credit.
  // This detects missing event or payment idempotency.
  { name: "sequential duplicate webhook", scenario: "sequential-duplicate-webhook", syntheticReferences, amountMinor, currency },

  // PayProof sends the same successful payment webhook three times at once.
  // Your application should still create only one customer credit.
  // This detects check-then-insert race conditions.
  { name: "concurrent duplicate credit", scenario: "concurrent-duplicate-credit", syntheticReferences, concurrency: 3, amountMinor, currency },

  // PayProof sends different successful payments at the same time.
  // Your application should credit each payment exactly once.
  // This detects accidental interference between unrelated payments.
  {
    name: "concurrent unique payments",
    scenario: "concurrent-unique-payments",
    syntheticReferences,
    amountMinor,
    currency
  },

  // PayProof sends checkout.completed and collection.succeeded for one payment.
  // Your application should treat them as one financial payment.
  // This detects crediting once per event type instead of once per payment.
  { name: "cross-event duplicate payment", scenario: "cross-event-duplicate-payment", syntheticReferences, amountMinor, currency },

  // PayProof sends a newer successful event and then an older expiry event.
  // Your application should keep the payment successful.
  // This detects older events incorrectly replacing newer state.
  { name: "out-of-order events", scenario: "out-of-order-events", syntheticReferences, amountMinor, currency },

  // PayProof sends an early lifecycle event and then a delayed success event.
  // Your application should eventually credit the valid payment once.
  // This detects workers that permanently reject a later valid confirmation.
  { name: "delayed payment confirmation", scenario: "delayed-payment-confirmation", syntheticReferences, delayMs: 50, amountMinor, currency },

  // PayProof sends a checkout that completed without a collected payment.
  // Your application should not create a customer credit.
  // This detects fulfillment based only on checkout completion.
  { name: "incomplete checkout", scenario: "incomplete-checkout", syntheticReferences, amountMinor, currency },

  // PayProof sends checkout.expired.
  // Your application should not create a customer credit for expiry.
  // This detects treating an expired checkout as a successful payment.
  { name: "expired checkout", scenario: "expired-checkout", syntheticReferences, amountMinor, currency },

  // PayProof changes the signed webhook body after signing it.
  // Your application should reject the request and create no credit.
  // This detects signature checks that do not use the original raw body.
  { name: "tampered webhook", scenario: "tampered-webhook", syntheticReferences, expectedStatus: "4xx", amountMinor, currency },

  // PayProof sends a valid-shaped event with an invalid signature.
  // Your application should reject the request and create no credit.
  // This detects missing or incorrect signature verification.
  { name: "invalid webhook signature", scenario: "invalid-webhook-signature", syntheticReferences, expectedStatus: "4xx", amountMinor, currency },

  // PayProof sends malformed JSON.
  // Your application should reject it safely and create no credit.
  // This detects unsafe parsing and error handling.
  { name: "malformed webhook", scenario: "malformed-webhook", syntheticReferences, expectedStatus: "4xx", amountMinor, currency },

  // PayProof sends a successful-looking event with the wrong amount.
  // Your application should not credit the order.
  // This detects fulfillment without exact amount matching.
  { name: "incorrect payment amount", scenario: "incorrect-payment-amount", syntheticReferences, amountMinor, currency },

  // PayProof sends a successful-looking event with the wrong currency.
  // Your application should not credit the order.
  // This detects currency-blind fulfillment.
  { name: "incorrect payment currency", scenario: "incorrect-payment-currency", syntheticReferences, amountMinor, currency },

  // PayProof sends a documented underpaid payment event.
  // Your application should not credit the customer before the shortfall is paid.
  // This detects fulfillment of an incomplete collection.
  { name: "underpaid payment", scenario: "underpaid-payment", syntheticReferences, amountMinor, currency },

  // PayProof sends a documented failed payment event.
  // Your application should not create a successful customer credit.
  // This detects fulfillment of a failed or retryable collection.
  { name: "failed payment", scenario: "failed-payment", syntheticReferences, amountMinor, currency }
];
`;

const setupTemplate = `/**
 * PayProof needs a payment reference because a webhook normally points to a
 * payment or order that already exists in your application. Your webhook
 * handler uses that reference to find the record it should update.
 *
 * This function prepares a TEST payment record. It does not charge a card,
 * contact Bachs, or move real money. You only implement it once; PayProof
 * calls it again for each applicable scenario and for each payment a scenario
 * needs. Every call must return a fresh, unique reference.
 *
 * STEP 1: Understand what PayProof gives you.
 *
 * context.amountMinor: the amount in the smallest currency unit. For a
 *   currency with two decimal places, 500000 means ₦5,000.
 * context.currency: the three-letter currency code, for example "NGN".
 * context.scenario: the test situation currently being prepared, for example
 *   "concurrent-duplicate-credit".
 * context.paymentIndex: which payment this is, starting at 0. The unique-
 *   payments scenario receives index 0 and index 1 for its two payments.
 * context.paymentCount: how many payments this scenario needs in total.
 *
 * STEP 2: Create a test payment.
 *
 * Replace the error below with your existing test payment creation logic. You
 * can call an application service, use your ORM, run a database seed helper,
 * or call an internal test API. You do not need to create a new API for
 * PayProof. Create a pending payment/order in an isolated test environment.
 *
 * Example database operation (adapt the model and field names to your app):
 *
 * import { randomUUID } from "node:crypto";
 *
 * const payment = await prisma.payment.create({
 *   data: {
 *     reference: \`payproof-\${context.scenario}-\${randomUUID()}\`,
 *     amountMinor: context.amountMinor,
 *     currency: context.currency,
 *     status: "PENDING"
 *   }
 * });
 *
 * STEP 3: Return the payment reference.
 *
 * A reference can be an order ID, payment reference, or application
 * idempotency key. It must be a value your webhook handler understands and
 * can use to find this exact test payment. Do not return the amount, a user
 * name, or a made-up value that does not exist in your application.
 *
 * STEP 4: Enable the function.
 *
 * Uncomment the import and createPayment property in payproof.config.mjs.
 * Until you do that, this helpful error is intentional: PayProof will not
 * silently invent fake references and pretend that a real payment was tested.
 */
export async function createPayment(context) {
  throw new Error(
    \`Open tests/payproof.setup.mjs and implement createPayment. It must create an isolated test payment and return its fresh reference (scenario: \${context.scenario}, payment \${context.paymentIndex + 1} of \${context.paymentCount}).\`
  );

  // Example using an existing test API instead of a database call:
  // const response = await fetch(process.env.PAYPROOF_TEST_API + "/payments", {
  //   method: "POST",
  //   headers: { "content-type": "application/json" },
  //   body: JSON.stringify({
  //     scenario: context.scenario,
  //     amountMinor: context.amountMinor,
  //     currency: context.currency,
  //     paymentIndex: context.paymentIndex
  //   })
  // });
  // if (!response.ok) throw new Error(\`test payment creation failed: HTTP \${response.status}\`);
  // const payment = await response.json();
  // return payment.reference;
}
`;

const verifierTemplate = `/**
 * Just because your webhook endpoint returns HTTP 200 does not mean the
 * customer's money was credited correctly. PayProof needs you to show it what
 * actually happened in your database.
 *
 * This file is not imported by your production server. It is test-only code.
 * Keep the implementation connected to an isolated test database, ledger, or
 * other application-owned state reader.
 *
 * STEP 1: Find the payment.
 * PayProof gives you the application's payment reference. Use it to retrieve
 * the payment or order your webhook should have updated.
 *
 * STEP 2: Find the actual financial records.
 * Read wallet credits, ledger entries, or the equivalent records that represent
 * money actually credited. Checking only payment.status is not enough: a bug
 * can leave the status looking correct while writing two credit records.
 *
 * STEP 3: Count the credits.
 * Zero records means zero credits. One record means one credit. Two records
 * may mean the duplicate webhook created duplicate money.
 *
 * STEP 4: Calculate the total credited amount.
 * If the customer should receive ₦5,000 and two separate ₦5,000 records exist,
 * the observed credited amount is ₦10,000. Return that observed total in minor
 * units so PayProof can detect the discrepancy.
 *
 * STEP 5: Return observed data.
 * reference: the same reference PayProof supplied.
 * creditCount: the number of actual credit records.
 * creditedAmountMinor: the sum of actual credit amounts in minor units.
 * currency: the currency of the observed records, such as "NGN".
 * status: optional application status, such as "COMPLETED".
 * pending: set true while a background job is still processing. Do not set
 *   pending false merely because an expected outcome says zero credits.
 * ledgerEntries: optional detailed records for the report.
 *
 * context.expectedOutcome describes what the test expects, but it is not proof
 * of what happened. Never return hardcoded expected values just to pass. Read
 * the committed records and let PayProof compare them with the expectation.
 *
 * STEP 6: Enable financial verification.
 * Implement the function, then uncomment the verify import, verify property,
 * and requireFinancialVerification property in payproof.config.mjs.
 */
export async function verify(reference, context) {
  throw new Error(
    \`Open tests/payproof.verify.mjs and implement verify by reading committed financial records for \${reference} before enabling it in payproof.config.mjs.\`
  );
}

// Complete example using an application-owned Prisma client. Replace the
// import path and model names with your application's actual test database.
// Uncomment this example after connecting it to your own records.
//
// import { prisma } from "../test-support/prisma.mjs";
//
// export async function verify(reference, context) {
//   const payment = await prisma.payment.findUnique({ where: { reference } });
//   const credits = await prisma.walletCredit.findMany({ where: { reference } });
//   const creditedAmountMinor = credits.reduce(
//     (total, credit) => total + Number(credit.amountMinor),
//     0
//   );
//
//   return {
//     reference,
//     creditCount: credits.length,
//     creditedAmountMinor,
//     currency: payment?.currency ?? context.expectedOutcome.currency,
//     status: payment?.status ?? "PENDING",
//     // Keep polling while a worker has not finished. This prevents an
//     // unfinished payment from being mistaken for proof of zero credits.
//     pending: !payment || payment.status === "PENDING",
//     ledgerEntries: credits.map((credit) => ({
//       id: String(credit.id),
//       type: String(credit.type),
//       amountMinor: Number(credit.amountMinor),
//       currency: credit.currency
//     }))
//   };
// }
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
  const configPath = join(root, "payproof.config.mjs");
  const testDirectory = join(root, "tests");
  const testPath = join(testDirectory, "payproof.test.mjs");
  const setupPath = join(testDirectory, "payproof.setup.mjs");
  const verifierPath = join(testDirectory, "payproof.verify.mjs");
  const paths = [configPath, testPath, setupPath, verifierPath];
  if (!force) {
    const existing = [];
    for (const path of paths) if (await exists(path)) existing.push(path);
    if (existing.length > 0) throw new Error(`Refusing to overwrite existing PayProof files: ${existing.join(", ")}. Use --force to replace them.`);
  }
  await mkdir(testDirectory, { recursive: true });
  await writeFile(configPath, configTemplate, "utf8");
  await writeFile(testPath, testTemplate, "utf8");
  await writeFile(setupPath, setupTemplate, "utf8");
  await writeFile(verifierPath, verifierTemplate, "utf8");
  return paths;
}
