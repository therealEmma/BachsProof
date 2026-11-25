import { createHmac } from "node:crypto";

/**
 * Create the documented Bachs V2 signature header for a raw request body.
 * This is intended for deterministic test delivery; it never performs a
 * provider API call or represents a live Bachs delivery.
 */
export function signBachsWebhook(rawBody: string | Uint8Array, secret: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  if (!secret) throw new Error("Bachs webhook signing requires a non-empty secret");
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new Error("Bachs webhook signature timestamp must be a non-negative integer");
  const payload = `${timestamp}.${typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8")}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return { "x-bachs-signature-v2": `t=${timestamp},v1=${signature}` };
}
