import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createReferenceWallet, InMemoryWalletStore } from "@payproof/reference-wallet";
import { createVitestPayProof } from "./src/index.js";

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
    const wallet = await createReferenceWallet({ mode: "corrected", store: new InMemoryWalletStore(), testEnvironment: true, testSecret: "payproof-example-secret" });
    closeWallet = wallet.close;
    server = createServer(wallet.app);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not start");
    const payproof = createVitestPayProof(`http://127.0.0.1:${address.port}`);
    const result = await payproof.run({ scenario: "concurrent-duplicate-credit", reference: "PAY-VITEST-INTEGRATION" });
    expect(result.passed).toBe(true);
  });
});
