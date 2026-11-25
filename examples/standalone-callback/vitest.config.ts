import { defineConfig } from "vitest/config";

// This config keeps the archive example independent from the parent workspace
// Vitest configuration and runs only the example's own test file.
export default defineConfig({
  test: { include: ["payproof.test.ts"] }
});
