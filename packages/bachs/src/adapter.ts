import type { ProviderAdapter } from "@bachsproof/core";
import { createBachsMockFixture, createBachsScenario, expectedBachsState, serializeBachsPaymentEvent, type BachsFixtureOptions, type BachsPaymentEvent } from "./fixtures.js";

export interface BachsAdapterOptions {
  mode: "mock";
  /** Optional isolated customer ID for database-backed integration tests. */
  customerId?: string;
}

/**
 * Build the provider-neutral adapter. Mock mode is explicit so a caller never
 * mistakes synthetic fixtures for authenticated provider traffic.
 */
export function bachsAdapter(options: BachsAdapterOptions): ProviderAdapter<BachsPaymentEvent> {
  if (options.mode !== "mock") {
    throw new Error("BachsProof currently supports only local mock mode. Use bachsAdapter({ mode: \"mock\" }); it does not call the Bachs sandbox.");
  }
  return {
    // These values are copied into reports and help distinguish provider modes.
    name: "Bachs",
    mode: "mock",
    createPayment(input) {
      return createBachsMockFixture({ customerId: options.customerId, ...input });
    },
    serialize(event) {
      return serializeBachsPaymentEvent(event);
    },
    expectedState(event) {
      return expectedBachsState(event);
    },
    createScenario(scenario, input) {
      return createBachsScenario(scenario, input, options.customerId);
    },
    headers() {
      return { "x-bachsproof-provider-mode": "mock" };
    }
  };
}
