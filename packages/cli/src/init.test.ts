import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "./init.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("BachsProof init", () => {
  it("generates one configuration file with both hard-fail callbacks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bachsproof-init-"));
    directories.push(directory);
    const paths = await initProject(directory);
    expect(paths).toHaveLength(1);
    expect(await readdir(directory)).toEqual(["bachsproof.config.mjs"]);
    const source = await readFile(join(directory, "bachsproof.config.mjs"), "utf8");
    expect(source).toContain("webhookUrl");
    expect(source).toContain("secret:");
    expect(source).toContain("createPayment");
    expect(source).toContain("verify");
    expect(source).toContain("Implement createPayment");
    expect(source).toContain("Implement verify");
    expect(source).toContain("sequential-duplicate-webhook");
    expect(source).not.toContain("syntheticReferences");
    expect(source).not.toContain("checkpoint");
    expect(source).not.toContain("replay");
  });

  it("protects an existing configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bachsproof-init-"));
    directories.push(directory);
    await initProject(directory);
    await expect(initProject(directory)).rejects.toThrow("Refusing to overwrite");
  });
});
