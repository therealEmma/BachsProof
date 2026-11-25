import { bachsAdapter } from "@bachsproof/cli";
import { tests } from "./tests/bachsproof.test.mjs";

const signingSecret = process.env.BACHS_WEBHOOK_SECRET;

export default {
  provider: bachsAdapter({ mode: "mock" }),
  target: {
    baseUrl: process.env.BACHSPROOF_TARGET_URL ?? "http://127.0.0.1:3000",
    webhookPath: process.env.BACHSPROOF_WEBHOOK_PATH ?? "/webhooks/bachs",
    // The CLI is black-box by default; isolation belongs to your test data.
    reset: false
  },
  tests,
  // Add a test-side verify(reference) callback when you want committed-state
  // financial assertions. It does not modify your production webhook code.
  ...(signingSecret ? { signing: { type: "bachs", secret: signingSecret } } : {})
};
