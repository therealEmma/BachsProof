import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 2 * 1024 * 1024,
    shell: process.platform === "win32" && command === pnpm
  });
}

describe("BachsProof CLI in an independent repository", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it("installs the CLI archive, initializes one file, and runs all eleven scenarios", async () => {
    const fixture = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "bachsproof-cli-independent-"));
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
    const coreArchive = archive("bachsproof-core-");
    const bachsArchive = archive("bachsproof-bachs-");
    const cliArchive = archive("bachsproof-cli-");
    await writeFile(join(fixture, "package.json"), JSON.stringify({
      name: "bachsproof-external-fixture",
      private: true,
      type: "module",
      dependencies: { "@bachsproof/cli": cliArchive, "@bachsproof/core": coreArchive, "@bachsproof/bachs": bachsArchive },
      pnpm: { overrides: { "@bachsproof/core": coreArchive, "@bachsproof/bachs": bachsArchive } }
    }, null, 2), "utf8");
    await run(pnpm, ["install", "--offline", "--ignore-scripts"], fixture);

    const initialized = await run(pnpm, ["exec", "bachsproof", "init"], fixture);
    expect(initialized.stdout).toContain("BachsProof initialized successfully.");
    expect(await readFile(join(fixture, "bachsproof.config.mjs"), "utf8")).toContain("createPayment");
    await expectAccess(join(fixture, "bachsproof.config.mjs"));
    await expectMissing(join(fixture, "tests"));

    const config = `import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { defineConfig } from "@bachsproof/cli";

const stateUrl = process.env.BACHSPROOF_STATE_URL;
export default defineConfig({
  webhookUrl: process.env.BACHSPROOF_WEBHOOK_URL,
  secret: process.env.BACHS_WEBHOOK_SECRET,
  amountMinor: 500000,
  currency: "NGN",
  createPayment: ({ scenario, paymentIndex }) => "AUTO-" + scenario + "-" + paymentIndex + "-" + randomUUID(),
  verify: async (reference) => {
    const response = await fetch(stateUrl + "?reference=" + encodeURIComponent(reference));
    const observed = await response.json();
    if (!response.ok) throw new Error("No committed state for " + reference);
    return { reference, creditCount: observed.creditCount, creditedAmountMinor: observed.amountMinor, currency: observed.currency };
  }
});
`;
    await writeFile(join(fixture, "bachsproof.config.mjs"), config, "utf8");

    const state = new Map<string, { creditCount: number; amountMinor: number; currency: string }>();
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/state")) {
        const reference = new URL(request.url, "http://127.0.0.1").searchParams.get("reference");
        const observed = reference ? state.get(reference) : undefined;
        response.statusCode = observed ? 200 : 404;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(observed ?? { error: "not-found" }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const signature = String(request.headers["x-bachs-signature-v2"] ?? "");
        const timestamp = Number(signature.match(/^t=(\d+),/)?.[1]);
        const expected = Number.isInteger(timestamp)
          ? `t=${timestamp},v1=${createHmac("sha256", "external-fixture-secret").update(`${timestamp}.${body}`).digest("hex")}`
          : "";
        if (signature !== expected) {
          response.statusCode = 400;
          response.end("invalid signature");
          return;
        }
        const event = JSON.parse(body) as { type: string; data: Record<string, string> };
        const reference = event.data.reference;
        if (reference) {
          const eligible = event.type === "collection.succeeded" && event.data.status === "SUCCEEDED" && event.data.currency === "NGN" && event.data.amount === "5000.00";
          const previous = state.get(reference) ?? { creditCount: 0, amountMinor: 0, currency: "NGN" };
          if (eligible && previous.creditCount === 0) state.set(reference, { creditCount: 1, amountMinor: 500000, currency: "NGN" });
          else if (!state.has(reference)) state.set(reference, previous);
        }
        response.statusCode = 200;
        response.end("accepted");
      });
    });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("independent fixture server did not start");
    const env = {
      BACHSPROOF_WEBHOOK_URL: `http://127.0.0.1:${address.port}/webhooks/bachs`,
      BACHSPROOF_STATE_URL: `http://127.0.0.1:${address.port}/state`,
      BACHS_WEBHOOK_SECRET: "external-fixture-secret"
    };
    const tested = await run(pnpm, ["exec", "bachsproof", "test", "--json"], fixture, env);
    const individual = await run(pnpm, ["exec", "bachsproof", "test", "--name", "underpaid-payment", "--json"], fixture, env);
    const result = JSON.parse(tested.stdout) as Array<{ result: { passed: boolean; report: { financiallyVerified: boolean } } }>;
    const one = JSON.parse(individual.stdout) as Array<{ result: { passed: boolean } }>;
    expect(result).toHaveLength(11);
    expect(result.every((entry) => entry.result.passed && entry.result.report.financiallyVerified)).toBe(true);
    expect(one).toHaveLength(1);
    expect(one[0]?.result.passed).toBe(true);
  }, 120_000);
});

async function expectAccess(path: string): Promise<void> {
  await access(path);
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}
