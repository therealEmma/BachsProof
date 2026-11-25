import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { signBachsWebhook } from "@payproof/bachs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let temporaryDirectories: string[] = [];
let servers: Server[] = [];

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 2 * 1024 * 1024,
    // Windows resolves pnpm through its .cmd shim. Node should be executed
    // directly so absolute paths and argument boundaries remain intact.
    shell: process.platform === "win32" && command === pnpm
  });
}

describe("PayProof CLI in an independent repository", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it("installs the CLI archive, initializes a project, and runs signed black-box tests", async () => {
    const fixture = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "payproof-cli-independent-"));
    temporaryDirectories.push(fixture);
    const archives = join(fixture, "archives");
    await mkdir(archives);
    await run(pnpm, ["pack", "--pack-destination", archives], join(root, "packages", "core"));
    await run(pnpm, ["pack", "--pack-destination", archives], join(root, "packages", "bachs"));
    await run(pnpm, ["pack", "--pack-destination", archives], join(root, "packages", "cli"));
    const archiveFiles = await readdir(archives);
    const archive = (prefix: string) => {
      const file = archiveFiles.find((candidate) => candidate.startsWith(prefix) && candidate.endsWith(".tgz"));
      if (!file) throw new Error(`Missing archive ${prefix}`);
      return `file:./archives/${file}`;
    };
    const coreArchive = archive("payproof-core-");
    const bachsArchive = archive("payproof-bachs-");
    const cliArchive = archive("payproof-cli-");
    await writeFile(join(fixture, "package.json"), JSON.stringify({
      name: "payproof-external-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@payproof/cli": cliArchive,
        "@payproof/core": coreArchive,
        "@payproof/bachs": bachsArchive
      },
      pnpm: {
        overrides: {
          "@payproof/core": coreArchive,
          "@payproof/bachs": bachsArchive
        }
      }
    }, null, 2), "utf8");
    await run(pnpm, ["install", "--offline", "--ignore-scripts"], fixture);

    const cliEntry = join(fixture, "node_modules", "@payproof", "cli", "dist", "cli.js");
    const help = await run(pnpm, ["exec", "payproof", "--help"], fixture);
    expect(help.stdout).toContain("PayProof payment correctness testing");
    const initialized = await run(pnpm, ["exec", "payproof", "init"], fixture);
    try {
      await access(join(fixture, "payproof.config.mjs"));
    } catch {
      throw new Error(`Installed CLI did not initialize the fixture. entry=${cliEntry}\nstdout=${initialized.stdout}\nstderr=${initialized.stderr}`);
    }
    expect(initialized.stdout).toContain("PayProof initialized successfully!");
    expect(initialized.stdout).toContain("Step 1: Open payproof.config.mjs");
    expect(initialized.stdout).toContain("Step 6: Run all payment scenarios");
    expect(await readFile(join(fixture, "payproof.config.mjs"), "utf8")).toContain("target");
    expect(await readFile(join(fixture, "tests", "payproof.test.mjs"), "utf8")).toContain("sequential-duplicate-webhook");
    expect(await readFile(join(fixture, "tests", "payproof.test.mjs"), "utf8")).not.toContain("PAYPROOF_REFERENCES");
    expect(await readFile(join(fixture, "tests", "payproof.setup.mjs"), "utf8")).toContain("Implement createPayment in tests/payproof.setup.mjs");
    expect(await readFile(join(fixture, "tests", "payproof.verify.mjs"), "utf8")).toContain("HTTP 200 only proves");
    expect(await readFile(join(fixture, "payproof.config.mjs"), "utf8")).toContain("@payproof/cli");

    let defaultRunOutput = "";
    try {
      await run(pnpm, ["exec", "payproof", "test"], fixture);
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      defaultRunOutput = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
    }
    expect(defaultRunOutput).toContain("Open tests/payproof.setup.mjs");

    await writeFile(join(fixture, "tests", "payproof.setup.mjs"), `import { randomUUID } from "node:crypto";

export async function createPayment(context) {
  return \`AUTO-\${context.scenario}-\${context.paymentIndex}-\${randomUUID()}\`;
}
`, "utf8");
    const configPath = join(fixture, "payproof.config.mjs");
    const generatedConfig = await readFile(configPath, "utf8");
    await writeFile(configPath, generatedConfig
      .replace("// import { createPayment } from \"./tests/payproof.setup.mjs\";", "import { createPayment } from \"./tests/payproof.setup.mjs\";")
      .replace("  // createPayment,", "  createPayment,"), "utf8");

    const requests: Array<{ body: string; signature?: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ body, signature: request.headers["x-bachs-signature-v2"] as string | undefined });
        const receivedSignature = request.headers["x-bachs-signature-v2"] as string | undefined;
        const timestamp = Number(receivedSignature?.match(/^t=(\d+),/)?.[1]);
        const expectedSignature = Number.isInteger(timestamp)
          ? signBachsWebhook(body, "external-fixture-secret", timestamp)["x-bachs-signature-v2"]
          : undefined;
        const rejected = body.startsWith("{\"invalid\":") || receivedSignature !== expectedSignature;
        response.statusCode = rejected ? 400 : 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ accepted: true }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("independent fixture server did not start");

    let tested: { stdout: string; stderr: string };
    try {
      tested = await run(pnpm, ["exec", "payproof", "test", "--json"], fixture, {
        PAYPROOF_TARGET_URL: `http://127.0.0.1:${address.port}`,
        PAYPROOF_WEBHOOK_PATH: "/webhooks/bachs",
        BACHS_WEBHOOK_SECRET: "external-fixture-secret",
        PAYPROOF_USE_SYNTHETIC_REFERENCES: ""
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      throw new Error(`${failure.message ?? "installed CLI failed"}\nstdout=${failure.stdout ?? ""}\nstderr=${failure.stderr ?? ""}`);
    }
    const runAgain = await run(pnpm, ["exec", "payproof", "test", "--json"], fixture, {
      PAYPROOF_TARGET_URL: `http://127.0.0.1:${address.port}`,
      PAYPROOF_WEBHOOK_PATH: "/webhooks/bachs",
      BACHS_WEBHOOK_SECRET: "external-fixture-secret",
      PAYPROOF_USE_SYNTHETIC_REFERENCES: ""
    });
    const individualRun = await run(pnpm, ["exec", "payproof", "test", "--name=\"underpaid payment\"", "--json"], fixture, {
      PAYPROOF_TARGET_URL: `http://127.0.0.1:${address.port}`,
      PAYPROOF_WEBHOOK_PATH: "/webhooks/bachs",
      BACHS_WEBHOOK_SECRET: "external-fixture-secret",
      PAYPROOF_USE_SYNTHETIC_REFERENCES: ""
    });
    const result = JSON.parse(tested.stdout) as Array<{ result: { passed: boolean; report: { financiallyVerified: boolean } } }>;
    const repeatedResult = JSON.parse(runAgain.stdout) as Array<{ result: { passed: boolean; report: { financiallyVerified: boolean } } }>;
    const individualResult = JSON.parse(individualRun.stdout) as Array<{ name: string; result: { passed: boolean; report: { financiallyVerified: boolean } } }>;
    expect(result).toHaveLength(15);
    expect(repeatedResult).toHaveLength(15);
    expect(individualResult).toHaveLength(1);
    expect(individualResult[0]?.name).toBe("underpaid payment");
    expect(result.every((entry) => entry.result.passed)).toBe(true);
    expect(repeatedResult.every((entry) => entry.result.passed)).toBe(true);
    expect(individualResult[0]?.result.passed).toBe(true);
    expect(result.every((entry) => entry.result.report.financiallyVerified === false)).toBe(true);
    expect(repeatedResult.every((entry) => entry.result.report.financiallyVerified === false)).toBe(true);
    expect(requests).toHaveLength(45);
    expect(requests.every((request) => request.signature?.startsWith("t=") && request.signature?.includes(",v1=") )).toBe(true);
    const references = requests.flatMap(({ body }) => [...body.matchAll(/"reference":"([^"]+)"/g)].map((match) => match[1]));
    // The malformed-body scenario intentionally has no parseable reference;
    // the other 14 single-payment scenarios plus two unique participants
    // produce 15 observable references per suite run.
    expect(new Set(references).size).toBe(31);
  }, 120_000);
});
