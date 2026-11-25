import { describe, expect, it } from "vitest";
import { checkpoint, configureCheckpoint, disableCheckpoints } from "./checkpoint.js";

describe("checkpoint SDK", () => {
  it("is a no-op when disabled", async () => {
    disableCheckpoints();
    await expect(checkpoint("disabled")).resolves.toBeUndefined();
  });

  it("supports caller cancellation and bounded timeout cleanup", async () => {
    configureCheckpoint({
      enabled: true,
      controllerUrl: "http://127.0.0.1:1",
      sessionId: "session",
      participantId: "participant",
      token: "token",
      defaultTimeoutMs: 100
    });
    const abort = new AbortController();
    abort.abort();
    await expect(checkpoint("cancelled", { signal: abort.signal })).rejects.toThrow("cancelled");
    disableCheckpoints();
  });
});
