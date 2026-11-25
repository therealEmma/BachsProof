import { createReferenceWallet } from "./index.js";

// The standalone process reads all operational values from environment
// variables so Railway credentials and test authorization never enter source.
const port = Number(process.env.PORT ?? 3000);
const mode = process.env.BACHSPROOF_WALLET_MODE === "corrected" ? "corrected" : "vulnerable";
const testEnvironment = process.env.BACHSPROOF_TEST_MODE === "true";
const bachsWebhookSecret = process.env.BACHS_WEBHOOK_SECRET;

// The server supports a local process with either an in-memory store (no
// DATABASE_URL) or the real Prisma/PostgreSQL store (Railway DATABASE_URL).
const wallet = await createReferenceWallet({
  mode,
  databaseUrl: process.env.DATABASE_URL,
  testEnvironment,
  bachsWebhookSecret
});
const server = wallet.app.listen(port, () => {
  console.log(`BachsProof reference wallet listening on http://localhost:${port} (${mode})`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Stop accepting new HTTP work and wait for active requests (including a
  // webhook transaction) to finish before disconnecting Prisma.
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await wallet.close();
};
const handleSignal = (signal: string) => {
  void shutdown().catch((error) => {
    console.error(`BachsProof shutdown failed after ${signal}:`, error);
    process.exitCode = 1;
  });
};
process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));
