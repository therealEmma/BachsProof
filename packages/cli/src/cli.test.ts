import { describe, expect, it } from "vitest";
import { scenarioLabel } from "./runner.js";

describe("CLI scenario names", () => {
  it("uses plain-language names for the supported scenarios", () => {
    expect(scenarioLabel("sequential-duplicate-webhook")).toBe("Sequential duplicate webhook");
    expect(scenarioLabel("failed-payment")).toBe("Failed payment");
  });
});
