import type { PaymentEvent } from "@bachsproof/core";
import type { BachsProofConfig } from "./types.js";

/** Type helper for bachsproof.config.mjs and bachsproof.config.ts files. */
export function defineConfig<TEvent extends PaymentEvent>(config: BachsProofConfig<TEvent>): BachsProofConfig<TEvent> {
  return config;
}
