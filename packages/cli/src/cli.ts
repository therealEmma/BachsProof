import { resolve } from "node:path";
import { initProject } from "./init.js";
import { loadConfig, runConfig, summarizeRuns } from "./runner.js";

function usage(): string {
  return `PayProof payment correctness testing

Usage:
  payproof init [directory] [--force]
  payproof test [--config <path>] [--name <test-name>] [--json]

init creates payproof.config.mjs, tests/payproof.test.mjs,
tests/payproof.setup.mjs, and a hard-fail tests/payproof.verify.mjs template.
test sends configured provider events to the target webhook and reports delivery
and, when configured, committed financial verification results.
`;
}

function explainOnboardingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Refusing to overwrite existing PayProof files")) {
    return `${message}\nOpen the listed files if you want to keep them, or run "payproof init --force" only when replacing them is intentional.`;
  }
  if (message.includes("real application reference is required") || message.includes("A real application reference is required")) {
    return `${message}\nOpen tests/payproof.setup.mjs and implement createPayment, or add a real reference to the selected test. Use PAYPROOF_USE_SYNTHETIC_REFERENCES=true only for an isolated fixture run.`;
  }
  if (message.includes("Payment preparation failed") || message.includes("createPayment must return")) {
    return `${message}\nOpen tests/payproof.setup.mjs. Create an isolated test payment and return its non-empty order or payment reference. PayProof will not send a webhook until preparation succeeds.`;
  }
  if (message.includes("already assigned to another selected scenario")) {
    return `${message}\nOpen tests/payproof.setup.mjs or tests/payproof.test.mjs and make each selected scenario use a fresh payment reference.`;
  }
  if (message.includes("Financial verification is required")) {
    return `${message}\nOpen tests/payproof.verify.mjs, implement verify(reference, context) by reading committed financial records, then enable verify and requireFinancialVerification in payproof.config.mjs.`;
  }
  if (message.includes("requires target.baseUrl") || message.includes("requires a provider adapter") || message.includes("requires at least one test")) {
    return `${message}\nOpen payproof.config.mjs and follow its numbered STEP sections. The provider, target URL/path, and tests are required.`;
  }
  if (message.includes("Financial verification returned")) {
    return `${message}\nOpen tests/payproof.verify.mjs and return the requested reference plus the actual creditCount, creditedAmountMinor, and currency from committed test data.`;
  }
  if (message.includes("Webhook delivery") && message.includes("HTTP 4")) {
    return `${message}\nOpen payproof.config.mjs STEP 2 and check PAYPROOF_TARGET_URL, PAYPROOF_WEBHOOK_PATH, and BACHS_WEBHOOK_SECRET. Your application may also be rejecting the test event as expected; set expectedStatus in tests/payproof.test.mjs when that rejection is part of the scenario.`;
  }
  if (message.includes("Webhook delivery") && message.includes("HTTP 5")) {
    return `${message}\nOpen your application's test webhook handler and logs. The application returned a server error while handling the simulated event.`;
  }
  if (message.includes("Test-state reset failed")) {
    return `${message}\nOpen payproof.config.mjs STEP 2. Set reset: false when your application owns test-data isolation, or configure the authorized test-only reset path.`;
  }
  if (message.includes("No PayProof test named")) {
    return `${message}\nOpen tests/payproof.test.mjs and copy the exact value from the test's name property, for example "sequential duplicate webhook".`;
  }
  return message;
}

function printInitializationGuide(): void {
  console.log(`
PayProof initialized successfully!

WHAT IS PAYPROOF?
PayProof sends simulated payment webhooks to your application and checks
whether your application handles money correctly. It does not move real money.

GET STARTED

Step 1: Open payproof.config.mjs
        Set your application's base URL, webhook path, and test-only signing secret.

Step 2: Open tests/payproof.setup.mjs
        Show PayProof how to create an isolated test payment and return its reference.
        This is optional when you provide references manually in the test file.

Step 3: Open tests/payproof.verify.mjs
        Show PayProof how to read the actual payment and credit records from your test data.

Step 4: Enable the two functions
        Uncomment createPayment in payproof.config.mjs. If you want financial
        correctness checks, also uncomment verify and requireFinancialVerification.

Step 5: Run your first test
        pnpm exec payproof test --name "sequential duplicate webhook"

Step 6: Run all payment scenarios
        pnpm exec payproof test

IMPORTANT
Only use PayProof against an isolated test environment.
Never send simulated payment webhooks to a production application.
`);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function redact(value: string, secret?: string): string {
  return secret ? value.replaceAll(secret, "[redacted]") : value;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (command === "init") {
    const directory = args.find((arg, index) => index > 0 && !arg.startsWith("-")) ?? process.cwd();
    const paths = await initProject(directory, has(args, "--force"));
    for (const path of paths) console.log(`created ${path}`);
    printInitializationGuide();
    return 0;
  }
  if (command !== "test") throw new Error(`Unknown command ${command}\n\n${usage()}`);

  const configPath = valueAfter(args, "--config") ?? "payproof.config.mjs";
  const testName = valueAfter(args, "--name");
  const config = await loadConfig(configPath);
  const results = await runConfig(config, { testName });
  const summary = summarizeRuns(results);
  const failed = results.some(({ result }) => !result.passed);
  if (has(args, "--json")) {
    const json = JSON.stringify(results, null, 2);
    console.log(redact(json, config.signing?.secret));
  } else {
    console.log(`PayProof: ${resolve(configPath)}`);
    for (const { name, result } of results) {
      const verification = result.report.financiallyVerified ? "financially verified" : "delivery-only; financial verification not configured";
      const duration = result.report.completedAt ? Math.max(0, Date.parse(result.report.completedAt) - Date.parse(result.report.startedAt)) : 0;
      const violations = result.report.verification?.violations.length ?? 0;
      console.log(`${result.passed ? "PASS" : "FAIL"} ${name} (${verification}; ${duration}ms; ${violations} financial violations)`);
      for (const error of result.report.errors) {
        console.log(`  ${redact(explainOnboardingError(error), config.signing?.secret).replaceAll("\n", "\n  ")}`);
      }
    }
    console.log(`Summary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.financiallyVerified} financially verified, ${summary.financiallyUnverified} unverified, ${summary.financialViolations} financial violations, ${summary.durationMs}ms`);
    if (!config.verify && !config.verification) {
      console.log("WARNING: black-box delivery success is not deterministic race coverage and does not prove committed financial correctness.");
    }
  }
  return failed ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(explainOnboardingError(error));
  process.exitCode = 1;
});
