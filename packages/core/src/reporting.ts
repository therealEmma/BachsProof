import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BachsProofReport } from "./types.js";

/** Write a human-readable JSON report and create its parent directory. */
export async function writeReport(report: BachsProofReport, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** Remove common credential formats before a diagnostic string enters a report. */
export function redactSecrets(value: string): string {
  return value.replace(/(authorization\s*[:=]\s*)([^,\s]+)/gi, "$1[REDACTED]").replace(/(token|secret|api[-_]?key)(\s*[:=]\s*)([^,\s]+)/gi, "$1$2[REDACTED]");
}
