import { resolve } from "node:path";
import { initProject } from "./init.js";
import { loadConfig, runConfig, summarizeRuns } from "./runner.js";
import { financialVerificationLabel } from "./verification-status.js";

function usage(): string {
  return `BachsProof payment correctness testing
Test whether your payment webhook handles money correctly.

Usage:
  bachsproof init [directory] [--force]
  bachsproof test [--config <path>] [--name <test-name>] [--json]

init creates a config, the scenario list, a payment-preparation template, and a
financial-verification template.
test sends configured test events to the target webhook and reports HTTP
delivery plus, when configured, the financial state your application committed.
`;
}

function explainOnboardingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Refusing to overwrite existing BachsProof files")) {
    return `${message}\nOpen the listed files if you want to keep them. Use "bachsproof init --force" only when replacing them is intentional.`;
  }
  if (message.includes("real application reference is required") || message.includes("A real application reference is required")) {
    return `${message}\nOpen tests/bachsproof.setup.mjs and implement createPayment, or add a fresh real reference to the selected test. Use BACHSPROOF_USE_SYNTHETIC_REFERENCES=true only for an isolated fixture run; that run is not financial proof.`;
  }
  if (message.includes("Payment preparation failed") || message.includes("createPayment must return")) {
    return `${message}\nOpen tests/bachsproof.setup.mjs. Create a fresh isolated test payment and return its non-empty reference. BachsProof will not send a webhook until preparation succeeds.`;
  }
  if (message.includes("already assigned to another selected scenario")) {
    return `${message}\nOpen tests/bachsproof.setup.mjs or tests/bachsproof.test.mjs. Each selected scenario needs its own fresh payment reference.`;
  }
  if (message.includes("Financial verification is required")) {
    return `${message}\nOpen tests/bachsproof.verify.mjs and implement verify(reference, context) by reading committed payment and credit records. Then enable verify and requireFinancialVerification in bachsproof.config.mjs.`;
  }
  if (message.includes("requires target.baseUrl") || message.includes("requires a provider adapter") || message.includes("requires at least one test")) {
    return `${message}\nOpen bachsproof.config.mjs. The provider, target URL/path, and at least one test are required. Use the generated comments as a checklist.`;
  }
  if (message.includes("Financial verification returned")) {
    return `${message}\nOpen tests/bachsproof.verify.mjs. Return the requested reference plus the actual creditCount, creditedAmountMinor, and currency read from committed test data.`;
  }
  if (message.includes("Webhook delivery") && message.includes("HTTP 4")) {
    return `${message}\nCheck BACHSPROOF_TARGET_URL, BACHSPROOF_WEBHOOK_PATH, and BACHS_WEBHOOK_SECRET. Your application may also be rejecting the test event on purpose; set expectedStatus in tests/bachsproof.test.mjs when that rejection is expected.`;
  }
  if (message.includes("Webhook delivery") && message.includes("HTTP 5")) {
    return `${message}\nOpen your application's test webhook handler and logs. The application returned a server error while handling the test event.`;
  }
  if (message.includes("No BachsProof test named")) {
    return `${message}\nOpen tests/bachsproof.test.mjs and copy the exact value from the test's name property, for example "sequential duplicate webhook".`;
  }
  return message;
}

function printInitializationGuide(): void {
  console.log(`
BachsProof initialized successfully!

WHAT IS BACHSPROOF?
BachsProof sends test payment webhooks to your application and checks whether
your application saved the right money state. It does not move real money.

GET STARTED

Step 1: Start your application with an isolated test database.

Step 2: Open bachsproof.config.mjs
        Set the test base URL, webhook path, and test-only signing secret.

Step 3: Open tests/bachsproof.setup.mjs
        Create a fresh test payment and return the reference your webhook reads.
        This is optional only when every test already has a real reference.

Step 4: Open tests/bachsproof.verify.mjs
        Read the actual payment and credit records from your test data.

Step 5: Enable the callbacks
        Uncomment createPayment. For financial proof, also uncomment verify and
        requireFinancialVerification.

Step 6: Run your first test
        pnpm exec bachsproof test --name "sequential duplicate webhook"

Step 7: Run all payment scenarios
        pnpm exec bachsproof test

IMPORTANT
Use an isolated application, database, queue, and webhook secret.
Never send test payment webhooks to production.
`);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (!inline) return undefined;
  return inline.slice(flag.length + 1).replace(/^("|')(.*)\1$/, "$2");
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

  const configPath = valueAfter(args, "--config") ?? "bachsproof.config.mjs";
  const testName = valueAfter(args, "--name");
  const config = await loadConfig(configPath);
  const results = await runConfig(config, { testName });
  const summary = summarizeRuns(results);
  const failed = results.some(({ result }) => !result.passed);
  if (has(args, "--json")) {
    const json = JSON.stringify(results, null, 2);
    console.log(redact(json, config.signing?.secret));
  } else {
    console.log(`BachsProof: ${resolve(configPath)}`);
    for (const { name, result } of results) {
      const verification = financialVerificationLabel(result.report);
      const duration = result.report.completedAt ? Math.max(0, Date.parse(result.report.completedAt) - Date.parse(result.report.startedAt)) : 0;
      const violations = result.report.verification?.violations.length ?? 0;
      console.log(`${result.passed ? "PASS" : "FAIL"} ${name} (${verification}; ${duration}ms; ${violations} financial violations)`);
      for (const error of result.report.errors) {
        console.log(`  ${redact(explainOnboardingError(error), config.signing?.secret).replaceAll("\n", "\n  ")}`);
      }
    }
    console.log(`Summary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.financiallyVerified} financially verified, ${summary.financiallyUnverified} unverified, ${summary.financialViolations} financial violations, ${summary.durationMs}ms`);
    if (!config.verify) {
      console.log("WARNING: this run checks delivery only. It does not prove committed financial correctness or deterministic race coverage.");
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
