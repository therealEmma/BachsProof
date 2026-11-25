import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "./init.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("PayProof init", () => {
  it("generates all scenario boilerplate and a hard-fail verifier template", async () => {
    const directory = await mkdtemp(join(tmpdir(), "payproof-init-"));
    directories.push(directory);
    const paths = await initProject(directory);
    expect(paths).toHaveLength(4);

    const testSource = await readFile(join(directory, "tests", "payproof.test.mjs"), "utf8");
    const configSource = await readFile(join(directory, "payproof.config.mjs"), "utf8");
    expect(configSource).toContain("STEP 1: Select your payment provider");
    expect(configSource).toContain("STEP 6: Select your payment tests");
    expect(configSource).toContain("baseUrl is the application address");
    expect(configSource).toContain("// createPayment: paymentPreparation");
    for (const scenario of [
      "sequential-duplicate-webhook",
      "concurrent-duplicate-credit",
      "concurrent-unique-payments",
      "cross-event-duplicate-payment",
      "out-of-order-events",
      "delayed-payment-confirmation",
      "incomplete-checkout",
      "expired-checkout",
      "tampered-webhook",
      "invalid-webhook-signature",
      "malformed-webhook",
      "incorrect-payment-amount",
      "incorrect-payment-currency",
      "underpaid-payment",
      "failed-payment"
    ]) expect(testSource).toContain(scenario);

    const verifierSource = await readFile(join(directory, "tests", "payproof.verify.mjs"), "utf8");
    expect(verifierSource).toContain("Just because your webhook endpoint returns HTTP 200");
    expect(verifierSource).toContain("Open tests/payproof.verify.mjs and implement verify");
    const setupSource = await readFile(join(directory, "tests", "payproof.setup.mjs"), "utf8");
    expect(setupSource).toContain("Open tests/payproof.setup.mjs and implement createPayment");
    expect(setupSource).toContain("STEP 1: Understand what PayProof gives you");
    expect(setupSource).toContain("Every call must return a fresh, unique reference");
    expect(setupSource).toContain("500000 means");
    expect(setupSource).toContain("pending payment/order");
    expect(verifierSource).toContain("creditedAmountMinor");
    expect(verifierSource).toContain("pending: !payment");
    expect(testSource).not.toContain("PAYPROOF_REFERENCES");
    expect(testSource).toContain("This detects check-then-insert race conditions");
    expect(testSource).toContain("pnpm exec payproof test --name");
  });
});
