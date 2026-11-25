import { fetch } from "undici";
import { describe, expect, it } from "vitest";
import { RaceController } from "./race-controller.js";

describe("race controller", () => {
  it("holds checkpoint requests until an explicit release", async () => {
    const controller = new RaceController();
    const session = await controller.registerSession({ participants: ["a", "b"] });
    const arrive = (participantId: string) => fetch(`${session.controllerUrl}/sessions/${session.id}/checkpoints/after-check/arrive`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ participantId, key: "PAY-001" })
    });
    const first = arrive("a");
    const second = arrive("b");
    await controller.waitForArrivals(session.id, "after-check", 2, 1_000);
    expect((await Promise.race([first.then(() => "released"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 20))]))).toBe("waiting");
    controller.release(session.id, "after-check");
    expect((await Promise.all([first, second])).every((response) => response.ok)).toBe(true);
    expect(controller.getTrace(session.id).map((event) => event.type)).toEqual(["arrival", "arrival", "release"]);
    await controller.close();
  });

  it("times out and aborts pending participants", async () => {
    const controller = new RaceController();
    const session = await controller.registerSession({ participants: ["a", "b"] });
    const request = fetch(`${session.controllerUrl}/sessions/${session.id}/checkpoints/cp/arrive`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ participantId: "a" })
    });
    await expect(controller.waitForArrivals(session.id, "cp", 2, 20)).rejects.toThrow("Timed out");
    controller.abort(session.id, "test-abort");
    expect((await request).status).toBe(409);
    await controller.close();
  });
});
