import { createHash } from "node:crypto";
import { mcnemarExact, wilsonInterval } from "./stats.js";

/** Separate from the frozen M6 safety gate. A safety PASS is not an improvement. */
export const IMPROVEMENT_POLICY = {
  version: "m7h-improvement-v1",
  minSample: 30,
  minAbsoluteTaskGain: 0.1,
  alpha: 0.05,
  objective: "task_correctness",
} as const;

export type ImprovementClass =
  | "VERIFIED_IMPROVEMENT"
  | "NO_VERIFIED_IMPROVEMENT"
  | "VERIFIED_REGRESSION"
  | "INCONCLUSIVE"
  | "EVALUATION_INVALID";

export type DeploymentEligibility = "eligible" | "ineligible" | "exceptional";

export interface ImprovementEvidence {
  sampleSize: number;
  taskBaseline: number;
  taskCandidate: number;
  formatBaseline: number;
  formatCandidate: number;
  baselineOnly: number | null;
  candidateOnly: number | null;
  taskBaselineCorrect: number | null;
  taskCandidateCorrect: number | null;
  checksumsMatch: boolean;
  contaminated: boolean;
  familyCompatible: boolean;
  evaluationPresent: boolean;
  benchmarkValid: boolean;
  retentionPresent: boolean;
  retentionPassed: boolean;
}

export interface ImprovementVerdict {
  classification: ImprovementClass;
  effectSize: number;
  pValue: number | null;
  claimSignificance: boolean;
  rationale: string;
  limitations: string;
  uncertainty: { baseline: { low: number; high: number } | null; candidate: { low: number; high: number } | null };
}

const LIMITATION = "Exact McNemar uses discordant pairs and treats items as independent. It is not a correction for multiple comparisons, and a non-significant result is not evidence of equality.";

export function improvementPolicyHash(): string {
  return createHash("sha256").update(JSON.stringify(IMPROVEMENT_POLICY)).digest("hex");
}

export function verifyImprovement(input: ImprovementEvidence): ImprovementVerdict {
  const effectSize = input.taskCandidate - input.taskBaseline;
  const uncertainty = intervals(input);
  const paired = pairedP(input);
  if (!input.evaluationPresent || !input.benchmarkValid || !input.checksumsMatch || input.contaminated || !input.familyCompatible) {
    return verdict("EVALUATION_INVALID", effectSize, paired.pValue, false, "The evaluation is missing, invalid, contaminated, or incompatible with the candidate.", uncertainty);
  }
  if (input.sampleSize < IMPROVEMENT_POLICY.minSample) {
    return verdict("INCONCLUSIVE", effectSize, paired.pValue, false, `Sample ${input.sampleSize} is below ${IMPROVEMENT_POLICY.minSample}. The result is not an improvement or a regression claim.`, uncertainty);
  }
  if (effectSize < 0) {
    return verdict("VERIFIED_REGRESSION", effectSize, paired.pValue, false, "Candidate task accuracy is lower than the baseline on a sufficient sample.", uncertainty);
  }
  if (effectSize === 0) {
    return verdict("NO_VERIFIED_IMPROVEMENT", effectSize, paired.pValue, false, "Task accuracy is unchanged. A format change does not verify the task-correctness objective.", uncertainty);
  }
  if (effectSize + 1e-12 < IMPROVEMENT_POLICY.minAbsoluteTaskGain) {
    return verdict("INCONCLUSIVE", effectSize, paired.pValue, false, `Task gain ${effectSize.toFixed(4)} is below the ${IMPROVEMENT_POLICY.minAbsoluteTaskGain} absolute effect required. A one-item difference is not sufficient.`, uncertainty);
  }
  if (!input.retentionPresent) {
    return verdict("INCONCLUSIVE", effectSize, paired.pValue, false, "Retention evidence is missing, so the task gain cannot be verified.", uncertainty);
  }
  if (!input.retentionPassed) {
    return verdict("NO_VERIFIED_IMPROVEMENT", effectSize, paired.pValue, false, "The required retention check failed.", uncertainty);
  }
  if (uncertainty.candidate && uncertainty.candidate.low <= input.taskBaseline) {
    return verdict("INCONCLUSIVE", effectSize, paired.pValue, false, "The candidate interval still overlaps the baseline task accuracy.", uncertainty);
  }
  if (paired.pValue === null) {
    return verdict("INCONCLUSIVE", effectSize, null, false, "Paired counts were not supplied, so significance was not claimed.", uncertainty);
  }
  if (paired.pValue >= IMPROVEMENT_POLICY.alpha) {
    return verdict("INCONCLUSIVE", effectSize, paired.pValue, false, `Paired McNemar p-value ${paired.pValue} does not meet ${IMPROVEMENT_POLICY.alpha}.`, uncertainty);
  }
  return verdict("VERIFIED_IMPROVEMENT", effectSize, paired.pValue, true, "Task accuracy improved by the required effect, the paired test met the alpha, retention passed, and the evaluation is valid.", uncertainty);
}

export function assessDeployment(input: {
  classification: ImprovementClass;
  safetyGate: string;
  approved: boolean;
  compatible: boolean;
  revoked: boolean;
  contaminated: boolean;
  purpose: "improvement" | "exceptional";
}): { eligibility: DeploymentEligibility; verifiedImprovement: boolean } {
  const blocked = !input.approved || !input.compatible || input.revoked || input.contaminated || input.safetyGate !== "PASS";
  if (blocked) {
    return { eligibility: "ineligible", verifiedImprovement: false };
  }
  if (input.purpose === "exceptional") {
    const denied = input.classification === "VERIFIED_IMPROVEMENT" || input.classification === "VERIFIED_REGRESSION" || input.classification === "EVALUATION_INVALID";
    return { eligibility: denied ? "ineligible" : "exceptional", verifiedImprovement: false };
  }
  if (input.classification === "VERIFIED_IMPROVEMENT") {
    return { eligibility: "eligible", verifiedImprovement: true };
  }
  return { eligibility: "ineligible", verifiedImprovement: false };
}

function verdict(classification: ImprovementClass, effectSize: number, pValue: number | null, claimSignificance: boolean, rationale: string, uncertainty: ImprovementVerdict["uncertainty"]): ImprovementVerdict {
  return { classification, effectSize, pValue, claimSignificance, rationale, limitations: LIMITATION, uncertainty };
}

function intervals(input: ImprovementEvidence): ImprovementVerdict["uncertainty"] {
  if (input.taskBaselineCorrect === null || input.taskCandidateCorrect === null || input.sampleSize <= 0) {
    return { baseline: null, candidate: null };
  }
  return {
    baseline: wilsonInterval(input.taskBaselineCorrect, input.sampleSize),
    candidate: wilsonInterval(input.taskCandidateCorrect, input.sampleSize),
  };
}

function pairedP(input: ImprovementEvidence): { pValue: number | null } {
  if (input.baselineOnly === null || input.candidateOnly === null) {
    return { pValue: null };
  }
  return { pValue: mcnemarExact(input.baselineOnly, input.candidateOnly) };
}
