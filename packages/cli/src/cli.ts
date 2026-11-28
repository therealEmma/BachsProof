import { initProject } from "./init.js";
import { formatHumanReadableReport, shouldUseColor } from "./formatter.js";
import { loadConfig, runConfig, summarizeRuns } from "./runner.js";

function usage(): string {
  return `BachsProof
Beyond webhook delivery. Verify financial correctness.

Usage:
  bachsproof init [directory] [--force]
  bachsproof test [--config <path>] [--name <scenario-name>] [--json]

init creates one bachsproof.config.mjs file.
test runs the five standard financial correctness scenarios unless --name or
scenarios in the config selects a subset.
`;
}

function explainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Refusing to overwrite existing BachsProof file")) {
    return `${message}\nOpen the existing file if you want to keep it. Use --force only when replacement is intentional.`;
  }
  if (message.includes("Implement createPayment")) {
    return `${message}\nThe callback must create a fresh record in your isolated test application and return its reference.`;
  }
  if (message.includes("Implement verify")) {
    return `${message}\nThe callback must read committed payment and ledger records. HTTP success alone is not financial proof.`;
  }
  if (message.includes("already used") || message.includes("duplicate payment references")) {
    return `${message}\nEvery selected scenario needs a fresh isolated payment record.`;
  }
  if (message.includes("Unknown BachsProof scenario")) {
    return `${message}\nUse the exact scenario identifier from the generated configuration comments.`;
  }
  if (message.includes("Webhook delivery")) {
    return `${message}\nCheck the isolated webhook URL and application logs. BachsProof still verifies financial state when it is safe to do so.`;
  }
  if (message.includes("Financial verification")) {
    return `${message}\nCheck that verify() reads the requested reference and reports actual committed financial state.`;
  }
  return message;
}

function printInitializationGuide(): void {
  console.log(`
BachsProof initialized successfully.

Open bachsproof.config.mjs and implement two callbacks:

1. createPayment() creates a fresh payment in your isolated test application.
2. verify() reads the committed payment and ledger records.

Then run:
  pnpm exec bachsproof test --name "sequential duplicate webhook"
  pnpm exec bachsproof test

Use a test-only application, database, queue, and webhook secret.
`);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1).replace(/^("|')(.*)\1$/, "$2");
}

function has(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function redact(value: string, secret: string): string {
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
    console.log(redact(JSON.stringify(results, null, 2), config.secret));
  } else {
    console.log(formatHumanReadableReport(results, summary, {
      useColor: shouldUseColor(),
      redact: (value) => redact(value, config.secret)
    }));
  }
  return failed ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(explainError(error));
  process.exitCode = 1;
});
