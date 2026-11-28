import { createJiti } from "jiti";
import { resolve } from "node:path";
import { BachsProof, SUPPORTED_SCENARIOS, type PaymentEvent, type PaymentReferenceCreator, type ProviderAdapter, type ScenarioName } from "@bachsproof/core";
import { bachsAdapter, signBachsWebhook } from "@bachsproof/bachs";
import type { BachsProofCliRun, BachsProofConfig, BachsProofSummary, RunConfigOptions } from "./types.js";

export const DEFAULT_SCENARIOS: ScenarioName[] = [
  "sequential-duplicate-webhook",
  "concurrent-duplicate-credit",
  "concurrent-unique-payments",
  "incorrect-payment-amount",
  "incorrect-payment-currency"
];

const SCENARIO_LABELS: Record<ScenarioName, string> = {
  "sequential-duplicate-webhook": "Sequential duplicate webhook",
  "concurrent-duplicate-credit": "Concurrent duplicate credit",
  "concurrent-unique-payments": "Concurrent unique payments",
  "cross-event-duplicate-payment": "Cross-event duplicate payment",
  "out-of-order-events": "Out-of-order events",
  "incomplete-checkout": "Checkout completed without payment",
  "expired-checkout": "Expired checkout",
  "incorrect-payment-amount": "Incorrect payment amount",
  "incorrect-payment-currency": "Incorrect payment currency",
  "underpaid-payment": "Underpaid payment",
  "failed-payment": "Failed payment"
};

const LEGACY_SCENARIO_LABELS: Partial<Record<ScenarioName, string[]>> = {
  "incomplete-checkout": ["Incomplete checkout"]
};

export function scenarioLabel(scenario: ScenarioName): string {
  return SCENARIO_LABELS[scenario];
}

function assertConfig(value: unknown): asserts value is BachsProofConfig {
  if (!value || typeof value !== "object") throw new Error("BachsProof config must export a default object");
  const config = value as Partial<BachsProofConfig>;
  if (typeof config.webhookUrl !== "string" || config.webhookUrl.trim().length === 0) {
    throw new Error("BachsProof config requires a complete webhookUrl");
  }
  try {
    const url = new URL(config.webhookUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("webhookUrl must use http or https");
  } catch (error) {
    throw new Error(`BachsProof config webhookUrl is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof config.secret !== "string" || config.secret.trim().length === 0) {
    throw new Error("BachsProof config requires a non-empty test webhook secret");
  }
  if (!Number.isSafeInteger(config.amountMinor) || (config.amountMinor as number) < 0) {
    throw new Error("BachsProof config amountMinor must be a non-negative safe integer");
  }
  if (typeof config.currency !== "string" || !/^[A-Z]{3}$/.test(config.currency)) {
    throw new Error("BachsProof config currency must be a three-letter ISO currency code");
  }
  if (typeof config.createPayment !== "function") throw new Error("BachsProof config requires a createPayment callback");
  if (typeof config.verify !== "function") throw new Error("BachsProof config requires a verify callback");
  if (config.verificationTimeoutMs !== undefined && (!Number.isSafeInteger(config.verificationTimeoutMs) || config.verificationTimeoutMs < 1)) {
    throw new Error("BachsProof config verificationTimeoutMs must be a positive safe integer");
  }
  if (config.scenarios !== undefined) {
    if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) throw new Error("BachsProof config scenarios must contain at least one scenario");
    for (const scenario of config.scenarios) {
      if (!(SUPPORTED_SCENARIOS as readonly string[]).includes(scenario)) {
        throw new Error(`Unknown BachsProof scenario: ${String(scenario)}`);
      }
    }
  }
}

/** Load a JavaScript, MJS, CJS, or TypeScript config file. */
export async function loadConfig(configPath = "bachsproof.config.mjs"): Promise<BachsProofConfig> {
  const absolutePath = resolve(process.cwd(), configPath);
  const jiti = createJiti(absolutePath, { interopDefault: true });
  const loaded = await jiti.import(absolutePath, { default: true }) as unknown;
  assertConfig(loaded);
  return loaded;
}

function withBachsSigning(provider: ProviderAdapter, secret: string): ProviderAdapter {
  return {
    ...provider,
    headers(event) {
      const body = provider.serialize(event);
      return {
        ...(provider.headers?.(event) ?? {}),
        ...signBachsWebhook(body, secret)
      };
    },
    headersForBody(event, body) {
      return {
        ...(provider.headersForBody?.(event, body) ?? provider.headers?.(event) ?? {}),
        ...signBachsWebhook(body, secret)
      };
    }
  };
}

function selectedScenarios(config: BachsProofConfig, testName?: string): ScenarioName[] {
  const scenarios = config.scenarios ?? DEFAULT_SCENARIOS;
  if (!testName) return scenarios;
  const selected = SUPPORTED_SCENARIOS.find((scenario) => scenarioLabel(scenario) === testName
    || scenario === testName
    || LEGACY_SCENARIO_LABELS[scenario]?.includes(testName));
  if (!selected) throw new Error(`Unknown BachsProof scenario or test name "${testName}". Use one of: ${SUPPORTED_SCENARIOS.map(scenarioLabel).join(", ")}`);
  return [selected];
}

export async function runConfig(config: BachsProofConfig, options: RunConfigOptions = {}): Promise<BachsProofCliRun[]> {
  assertConfig(config);
  const scenarios = selectedScenarios(config, options.testName);
  const provider = withBachsSigning(bachsAdapter({ mode: "mock" }), config.secret);
  const usedReferences = new Set<string>();
  const createPayment: PaymentReferenceCreator = async (context) => {
    const reference = await config.createPayment(context);
    if (typeof reference !== "string" || reference.trim().length === 0) return reference as string;
    const normalized = reference.trim();
    if (usedReferences.has(normalized)) {
      throw new Error(`createPayment returned reference ${normalized}, which was already used by another selected scenario`);
    }
    usedReferences.add(normalized);
    return normalized;
  };
  const runner = new BachsProof({
    provider,
    webhookUrl: config.webhookUrl,
    createPayment,
    verify: config.verify,
    financialVerification: config.verificationTimeoutMs === undefined ? undefined : { completionDeadlineMs: config.verificationTimeoutMs }
  });
  const results: BachsProofCliRun[] = [];
  for (const scenario of scenarios) {
    const result = await runner.run({
      scenario,
      amountMinor: config.amountMinor,
      currency: config.currency
    });
    results.push({ name: scenarioLabel(scenario), scenario, result });
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

export { bachsAdapter, signBachsWebhook } from "@bachsproof/bachs";
