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
    expect(configSource).toContain("PayProof test configuration");
    expect(configSource).toContain("webhookPath");
    expect(configSource).toContain("// createPayment,");
    expect(configSource).not.toContain("resetPath");
    expect(configSource).toContain("financialVerification");
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
    expect(verifierSource).toContain("HTTP 200 only proves");
    expect(verifierSource).toContain("Implement verify in tests/payproof.verify.mjs");
    const setupSource = await readFile(join(directory, "tests", "payproof.setup.mjs"), "utf8");
    expect(setupSource).toContain("Implement createPayment in tests/payproof.setup.mjs");
    expect(setupSource).toContain("fresh test payment or order");
    expect(setupSource).toContain("paymentIndex");
    expect(verifierSource).toContain("creditedAmountMinor");
    expect(verifierSource).toContain("pending");
    expect(testSource).not.toContain("PAYPROOF_REFERENCES");
    expect(testSource).toContain("tests duplicate-credit races");
    expect(testSource).toContain("pnpm exec payproof test --name");
  });
});
