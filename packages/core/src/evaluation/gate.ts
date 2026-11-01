import { createHash } from "node:crypto";
import type { PairedCounts } from "./stats.js";

export const GATE_POLICY = {
  version: "m6-gate-v1",
  minSampleForPass: 30,
  criticalDomains: ["arithmetic"],
  formatCannotOffsetTaskLoss: true,
} as const;

export type GateDecision = "PASS" | "FAIL" | "INCONCLUSIVE" | "QUARANTINED";

export function gatePolicyHash(): string {
  return createHash("sha256").update(JSON.stringify(GATE_POLICY)).digest("hex");
}

export function decideGate(input: {
  domain: string;
  paired: PairedCounts;
  baselineFormat: number;
  candidateFormat: number;
  checksumsMatch: boolean;
  contaminated: boolean;
}): { decision: GateDecision; rationale: string; critical: string[]; warnings: string[] } {
  const critical: string[] = [];
  const warnings: string[] = [];
  if (!input.checksumsMatch) {
    critical.push("artifact checksum mismatch");
  }
  if (input.contaminated) {
    critical.push("artifact is marked potentially contaminated");
  }
  const taskDropped = input.paired.candidateAccuracy < input.paired.baselineAccuracy;
  const mandatory = (GATE_POLICY.criticalDomains as readonly string[]).includes(input.domain);
  if (mandatory && taskDropped) {
    critical.push("arithmetic task correctness fell; a format gain cannot offset it");
  }
  if (input.candidateFormat + 1e-9 < input.baselineFormat) {
    warnings.push("output format compliance fell");
  }
  if (input.paired.sampleSize < GATE_POLICY.minSampleForPass) {
    warnings.push(`sample size ${input.paired.sampleSize} is below ${GATE_POLICY.minSampleForPass}`);
  }
  if (critical.some((item) => item.startsWith("artifact"))) {
    return { decision: "QUARANTINED", rationale: critical.join(". "), critical, warnings };
  }
  if (critical.length > 0) {
    return { decision: "FAIL", rationale: critical.join(". "), critical, warnings };
  }
  if (input.paired.sampleSize < GATE_POLICY.minSampleForPass) {
    return {
      decision: "INCONCLUSIVE",
      rationale: `Diagnostic only. ${input.paired.sampleSize} items cannot authorize acceptance.`,
      critical,
      warnings,
    };
  }
  return { decision: "PASS", rationale: "Sample, checksums, and mandatory metrics met the frozen policy.", critical, warnings };
}
