import type { PaymentEvent } from "@payproof/core";
import type { PayProofConfig } from "./types.js";

/** Type helper for payproof.config.mjs and payproof.config.ts files. */
export function defineConfig<TEvent extends PaymentEvent>(config: PayProofConfig<TEvent>): PayProofConfig<TEvent> {
  return config;
}
