import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createReferenceWallet, InMemoryWalletStore } from "@bachsproof/reference-wallet";
import { createVitestBachsProof } from "./src/index.js";
import { runConfig } from "@bachsproof/cli";

describe("Vitest integration example", () => {
  let server: Server | undefined;
  let closeWallet: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await closeWallet?.();
    server = undefined;
    closeWallet = undefined;
  });

  it("prevents duplicate wallet credits", async () => {
    const wallet = await createReferenceWallet({ mode: "corrected", store: new InMemoryWalletStore(), testEnvironment: true });
    closeWallet = wallet.close;
    server = createServer(wallet.app);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not start");
    const config = createVitestBachsProof(
      `http://127.0.0.1:${address.port}/webhooks/bachs`,
      async ({ amountMinor, currency }) => (await wallet.createPayment({ amountMinor, currency })).reference,
      (reference) => wallet.store.inspect(reference)
    );
    const [run] = await runConfig(config, { testName: "Concurrent duplicate credit" });
    expect(run?.result.passed).toBe(true);
  });
});
