import { createJiti } from "jiti";
import { resolve } from "node:path";
import { BachsProof, type PaymentEvent, type PaymentReferenceCreator, type ProviderAdapter } from "@bachsproof/core";
import { signBachsWebhook } from "@bachsproof/bachs";
import type { BachsProofCliRun, BachsProofConfig, BachsProofSummary, RunConfigOptions } from "./types.js";

function assertConfig(value: unknown): asserts value is BachsProofConfig {
  if (!value || typeof value !== "object") throw new Error("BachsProof config must export a default object");
  const config = value as Partial<BachsProofConfig>;
  if (!config.provider || typeof config.provider !== "object") throw new Error("BachsProof config requires a provider adapter");
  if (!config.target || typeof config.target !== "object" || typeof config.target.baseUrl !== "string" || typeof config.target.webhookPath !== "string") {
    throw new Error("BachsProof config requires target.baseUrl and target.webhookPath");
  }
  if (!Array.isArray(config.tests) || config.tests.length === 0) throw new Error("BachsProof config requires at least one test");
}

/** Load .mjs, .js, .cjs, or TypeScript config without requiring a repo-local loader. */
export async function loadConfig(configPath = "bachsproof.config.mjs"): Promise<BachsProofConfig> {
  const absolutePath = resolve(process.cwd(), configPath);
  const jiti = createJiti(absolutePath, { interopDefault: true });
  const loaded = await jiti.import(absolutePath, { default: true }) as unknown;
  assertConfig(loaded);
  return loaded;
}

function withBachsSigning<TEvent extends PaymentEvent>(provider: ProviderAdapter<TEvent>, config: BachsProofConfig<TEvent>): ProviderAdapter<TEvent> {
  if (!config.signing) return provider;
  if (config.signing.type !== "bachs") throw new Error(`Unsupported signing type ${String(config.signing.type)}`);
  if (!config.signing.secret) throw new Error("Bachs signing is configured but its secret is empty");
  return {
    ...provider,
    headers(event) {
      const rawBody = provider.serialize(event);
      return {
        ...(provider.headers?.(event) ?? {}),
        ...signBachsWebhook(rawBody, config.signing?.secret ?? "", config.signing?.timestamp)
      };
    },
    headersForBody(event, body) {
      return {
        ...(provider.headersForBody?.(event, body) ?? provider.headers?.(event) ?? {}),
        ...signBachsWebhook(body, config.signing?.secret ?? "", config.signing?.timestamp)
      };
    }
  };
}

export async function runConfig(config: BachsProofConfig, options: RunConfigOptions = {}): Promise<BachsProofCliRun[]> {
  const tests = options.testName ? config.tests.filter((test) => test.name === options.testName) : config.tests;
  if (tests.length === 0) throw new Error(options.testName ? `No BachsProof test named ${options.testName}` : "BachsProof config contains no tests");
  if (config.requireFinancialVerification && !config.verify) {
    throw new Error("Financial verification is required, but the config has no verify callback");
  }

  const provider = withBachsSigning(config.provider, config);
  const results: BachsProofCliRun[] = [];
  const usedReferences = new Set<string>();
  for (const test of tests) {
    const { name, ...runOptions } = test;
    const normalizedRunOptions = {
      ...runOptions,
      ...(runOptions.reference !== undefined ? { reference: typeof runOptions.reference === "string" ? runOptions.reference.trim() : runOptions.reference } : {}),
      ...(runOptions.references !== undefined ? { references: runOptions.references.map((reference) => typeof reference === "string" ? reference.trim() : reference) } : {})
    };
    const explicitReferences = normalizedRunOptions.scenario === "concurrent-unique-payments"
      ? normalizedRunOptions.references ?? []
      : normalizedRunOptions.reference ? [normalizedRunOptions.reference] : [];
    const normalizedExplicitReferences = explicitReferences.map((reference) => typeof reference === "string" ? reference.trim() : reference);
    const conflictingReference = normalizedExplicitReferences.find((reference) => typeof reference === "string" && usedReferences.has(reference));
    let preparationFailure: string | undefined;
    if (conflictingReference) {
      preparationFailure = `Payment preparation failed for ${runOptions.scenario}: reference ${conflictingReference} is already assigned to another selected scenario`;
    } else {
      for (const reference of normalizedExplicitReferences) {
        if (typeof reference === "string" && reference.trim().length > 0) usedReferences.add(reference.trim());
      }
    }
    const createPayment: PaymentReferenceCreator | undefined = preparationFailure
      ? async () => { throw new Error(preparationFailure); }
      : config.createPayment
        ? async (context) => {
          const reference = await config.createPayment?.(context);
          if (typeof reference !== "string" || reference.trim().length === 0) return reference as string;
          const normalized = reference.trim();
          if (usedReferences.has(normalized)) {
            throw new Error(`reference ${normalized} is already assigned to another selected scenario`);
          }
          usedReferences.add(normalized);
          return normalized;
        }
        : undefined;
    const runner = new BachsProof({
      provider,
      target: config.target,
      createPayment,
      verify: config.verify,
      financialVerification: config.financialVerification,
      checkpoint: config.checkpoint
    });
    const input = preparationFailure
      ? { ...normalizedRunOptions, reference: undefined, references: undefined, syntheticReferences: false }
      : normalizedRunOptions;
    const result = await runner.run(input);
    if (config.requireFinancialVerification && !result.report.financiallyVerified) {
      result.report.errors.push("Financial verification was required but did not run");
      result.passed = false;
    }
    results.push({ name, result });
  }
  return results;
}

export function summarizeRuns(results: BachsProofCliRun[]): BachsProofSummary {
  const durationMs = results.reduce((total, { result }) => {
    if (!result.report.completedAt) return total;
    return total + Math.max(0, Date.parse(result.report.completedAt) - Date.parse(result.report.startedAt));
  }, 0);
  return {
    total: results.length,
    passed: results.filter(({ result }) => result.passed).length,
    failed: results.filter(({ result }) => !result.passed).length,
    financiallyVerified: results.filter(({ result }) => result.report.financiallyVerified).length,
    financiallyUnverified: results.filter(({ result }) => !result.report.financiallyVerified).length,
    financialViolations: results.reduce((total, { result }) => total + (result.report.verification?.violations.length ?? 0), 0),
    durationMs
  };
}
