import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "apps/**/tests/**/*.test.ts",
      "examples/**/*.test.ts"
    ],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // The reference-wallet integration suites use ephemeral HTTP servers and
    // process-local stores. Serialize files so their controlled schedules and
    // cleanup cannot overlap when `pnpm test` runs the whole workspace.
    fileParallelism: false,
    reporters: ["default"]
  },
  resolve: {
    alias: {
      "@payproof/sdk": resolve(__dirname, "packages/sdk/src/index.ts"),
      "@payproof/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@payproof/bachs": resolve(__dirname, "packages/bachs/src/index.ts"),
      "@payproof/reference-wallet": resolve(__dirname, "apps/reference-wallet/src/index.ts")
    }
  }
});
