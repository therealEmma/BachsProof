import { access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const configTemplate = `/**
 * BachsProof v2 configuration.
 *
 * Use only an isolated application, test database, queue, and webhook secret.
 * BachsProof creates local simulated events. It never calls Bachs or moves money.
 */
import { defineConfig } from "@bachsproof/cli";

export default defineConfig({
  // The complete URL of your isolated application's Bachs webhook route.
  webhookUrl: process.env.BACHSPROOF_WEBHOOK_URL ?? "http://127.0.0.1:3000/webhooks/bachs",

  // Use a secret that belongs only to your test application.
  secret: process.env.BACHS_WEBHOOK_SECRET ?? "",

  // 500,000 NGN minor units means NGN 5,000.00.
  amountMinor: 500_000,
  currency: "NGN",

  // Before BachsProof sends a webhook, create a fresh payment record and
  // return its reference. Replace the example error with your test helper.
  async createPayment({ scenario, amountMinor, currency, paymentIndex, paymentCount }) {
    throw new Error(
      "Implement createPayment in bachsproof.config.mjs. " +
      "Create an isolated test payment and return its non-empty reference for " +
      scenario + " (" + (paymentIndex + 1) + " of " + paymentCount + ")."
    );
    // Example:
    // const payment = await testApplication.createPayment({ amountMinor, currency });
    // return payment.reference;
  },

  // Read the application's committed payment and ledger records. Do not return
  // the expected values from this file; return what the database contains.
  async verify(reference) {
    throw new Error(
      "Implement verify in bachsproof.config.mjs by reading committed " +
      "financial records for " + reference + "."
    );
    // Example result:
    // return {
    //   reference,
    //   creditCount: credits.length,
    //   creditedAmountMinor: credits.reduce((sum, credit) => sum + credit.amountMinor, 0),
    //   currency: payment.currency,
    //   status: payment.status,
    //   pending: false,
    //   ledgerEntries: credits.map((credit) => ({
    //     id: String(credit.id),
    //     type: String(credit.type),
    //     amountMinor: credit.amountMinor,
    //     currency: credit.currency
    //   }))
    // };
  }

  // Optional: run only selected scenario identifiers. Omit to run the five standard scenarios.
  // scenarios: ["sequential-duplicate-webhook"],

  // Optional: increase this only when your isolated application processes
  // webhooks asynchronously. The default is 10 seconds.
  // verificationTimeoutMs: 10_000
});
`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Create exactly one config file and never overwrite it accidentally. */
export async function initProject(directory = process.cwd(), force = false): Promise<string[]> {
  const configPath = join(resolve(directory), "bachsproof.config.mjs");
  if (!force && await exists(configPath)) {
    throw new Error(`Refusing to overwrite existing BachsProof file: ${configPath}. Use --force only when replacement is intentional.`);
  }
  await writeFile(configPath, configTemplate, "utf8");
  return [configPath];
}
