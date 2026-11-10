/**
 * Skill and family totals for one frozen Math suite.
 * A skill is not an adapter, and this module does not route or train.
 */
import { compareManifests, type ComparisonResult } from "./compare.js";
import type { EvaluationManifest } from "./manifest.js";
import {
  MATH_DEPARTMENT_ID,
  MATH_SKILLS,
  type MathDifficulty,
  type MathFamilyId,
  type MathSkillId,
} from "./math-suite.js";

export const MATH_SKILL_CATALOG_VERSION = "c18a-math-skills-v1" as const;
export const MATH_STRONG_SKILL_ACCURACY = 0.75;
export const MATH_STRONG_SKILL_MIN_ITEMS = 2;

export interface SpecializationObservation {
  itemId: string;
  departmentId: string;
  skillId: MathSkillId;
  equationFamily: MathFamilyId;
  difficulty: MathDifficulty;
  templateId: string;
  generatorVersion: string;
  taskCorrect: boolean;
}

export interface SpecializationSlice {
  correct: number;
  sampleSize: number;
  accuracy: number;
}

export interface SkillSlice extends SpecializationSlice {
  departmentId: typeof MATH_DEPARTMENT_ID;
  skillId: MathSkillId;
}

export interface FamilySlice extends SpecializationSlice {
  equationFamily: MathFamilyId;
}

export interface SpecializationSummary {
  catalogVersion: typeof MATH_SKILL_CATALOG_VERSION;
  departmentId: typeof MATH_DEPARTMENT_ID;
  departmentAccuracy: number;
  correct: number;
  sampleSize: number;
  bySkill: SkillSlice[];
  byFamily: FamilySlice[];
  adapterBinding: "none";
}

export type SkillChangeKind = "improved" | "unchanged" | "declined" | "regressed";

export interface SkillChange extends SpecializationSlice {
  skillId: MathSkillId;
  baselineAccuracy: number;
  candidateAccuracy: number;
  accuracyChange: number;
  change: SkillChangeKind;
  previouslyStrong: boolean;
  missedItemIds: string[];
}

export interface FamilyChange extends SpecializationSlice {
  equationFamily: MathFamilyId;
  baselineAccuracy: number;
  candidateAccuracy: number;
  accuracyChange: number;
}

export interface SpecializationSide {
  conditionId: string;
  contentHash: string;
  generatorVersion: string;
  itemSetFingerprint: string;
  manifest: EvaluationManifest;
  items: readonly SpecializationObservation[];
}

export interface SpecializationComparison {
  comparable: boolean;
  reasons: string[];
  manifestComparison: ComparisonResult | null;
  benchmark: {
    contentHash: string | null;
    generatorVersion: string | null;
    conditionId: string | null;
  };
  departmentId: typeof MATH_DEPARTMENT_ID;
  overall: {
    baselineAccuracy: number;
    candidateAccuracy: number;
    accuracyChange: number;
  } | null;
  bySkill: SkillChange[];
  byFamily: FamilyChange[];
  regressions: SkillChange[];
  weakSkills: Array<{
    skillId: MathSkillId;
    accuracy: number;
    sampleSize: number;
    missedItemIds: string[];
    trainingProposal: "not_created";
  }>;
  adapterPerSkill: false;
  memoryWrite: false;
  weightRecalculation: "not_run";
}

export function summarizeSpecializations(
  items: readonly SpecializationObservation[],
): SpecializationSummary {
  const correct = items.filter((item) => item.taskCorrect).length;
  return {
    catalogVersion: MATH_SKILL_CATALOG_VERSION,
    departmentId: MATH_DEPARTMENT_ID,
    departmentAccuracy: ratio(correct, items.length),
    correct,
    sampleSize: items.length,
    bySkill: MATH_SKILLS.map((skillId) => skillSlice(skillId, items)),
    byFamily: familyIds(items).map((equationFamily) => familySlice(equationFamily, items)),
    adapterBinding: "none",
  };
}

export function compareSpecializations(
  baseline: SpecializationSide,
  candidate: SpecializationSide,
): SpecializationComparison {
  const reasons: string[] = [];
  if (baseline.conditionId !== candidate.conditionId) {
    reasons.push("Evaluation conditions differ.");
  }
  if (
    baseline.contentHash !== candidate.contentHash ||
    baseline.generatorVersion !== candidate.generatorVersion
  ) {
    reasons.push("Frozen benchmark versions differ.");
  }
  if (baseline.itemSetFingerprint !== candidate.itemSetFingerprint) {
    reasons.push("Benchmark item sets differ.");
  }
  const manifestComparison = compareManifests(baseline.manifest, candidate.manifest);
  const manifestOk = manifestsCompatible(baseline.manifest, candidate.manifest, manifestComparison);
  if (!manifestOk) {
    reasons.push(...manifestComparison.reasons);
  }
  const paired = pairItems(baseline.items, candidate.items);
  if (!paired.ok) {
    reasons.push(paired.reason);
  }
  const comparable = reasons.length === 0 && paired.ok;
  if (!comparable || !paired.ok) {
    return emptyComparison(reasons, manifestComparison);
  }
  const bySkill = MATH_SKILLS.map((skillId) => skillChange(skillId, paired.rows));
  const byFamily = familyIds(paired.rows.map((row) => row.baseline)).map((equationFamily) =>
    familyChange(equationFamily, paired.rows),
  );
  const baselineCorrect = paired.rows.filter((row) => row.baseline.taskCorrect).length;
  const candidateCorrect = paired.rows.filter((row) => row.candidate.taskCorrect).length;
  return {
    comparable: true,
    reasons: [],
    manifestComparison,
    benchmark: {
      contentHash: baseline.contentHash,
      generatorVersion: baseline.generatorVersion,
      conditionId: baseline.conditionId,
    },
    departmentId: MATH_DEPARTMENT_ID,
    overall: {
      baselineAccuracy: ratio(baselineCorrect, paired.rows.length),
      candidateAccuracy: ratio(candidateCorrect, paired.rows.length),
      accuracyChange:
        ratio(candidateCorrect, paired.rows.length) - ratio(baselineCorrect, paired.rows.length),
    },
    bySkill,
    byFamily,
    regressions: bySkill.filter((skill) => skill.change === "regressed"),
    weakSkills: bySkill
      .filter((skill) => skill.candidateAccuracy < 1)
      .map((skill) => ({
        skillId: skill.skillId,
        accuracy: skill.candidateAccuracy,
        sampleSize: skill.sampleSize,
        missedItemIds: skill.missedItemIds,
        trainingProposal: "not_created" as const,
      })),
    adapterPerSkill: false,
    memoryWrite: false,
    weightRecalculation: "not_run",
  };
}

function skillSlice(skillId: MathSkillId, items: readonly SpecializationObservation[]): SkillSlice {
  const group = items.filter((item) => item.skillId === skillId);
  const correct = group.filter((item) => item.taskCorrect).length;
  return {
    departmentId: MATH_DEPARTMENT_ID,
    skillId,
    correct,
    sampleSize: group.length,
    accuracy: ratio(correct, group.length),
  };
}

function familySlice(
  equationFamily: MathFamilyId,
  items: readonly SpecializationObservation[],
): FamilySlice {
  const group = items.filter((item) => item.equationFamily === equationFamily);
  const correct = group.filter((item) => item.taskCorrect).length;
  return {
    equationFamily,
    correct,
    sampleSize: group.length,
    accuracy: ratio(correct, group.length),
  };
}

function skillChange(
  skillId: MathSkillId,
  rows: readonly { baseline: SpecializationObservation; candidate: SpecializationObservation }[],
): SkillChange {
  const group = rows.filter((row) => row.baseline.skillId === skillId);
  const baselineCorrect = group.filter((row) => row.baseline.taskCorrect).length;
  const candidateCorrect = group.filter((row) => row.candidate.taskCorrect).length;
  const baselineAccuracy = ratio(baselineCorrect, group.length);
  const candidateAccuracy = ratio(candidateCorrect, group.length);
  const previouslyStrong =
    group.length >= MATH_STRONG_SKILL_MIN_ITEMS && baselineAccuracy >= MATH_STRONG_SKILL_ACCURACY;
  const accuracyChange = candidateAccuracy - baselineAccuracy;
  const declined = accuracyChange < 0;
  return {
    skillId,
    correct: candidateCorrect,
    sampleSize: group.length,
    accuracy: candidateAccuracy,
    baselineAccuracy,
    candidateAccuracy,
    accuracyChange,
    previouslyStrong,
    change: declined
      ? previouslyStrong
        ? "regressed"
        : "declined"
      : accuracyChange > 0
        ? "improved"
        : "unchanged",
    missedItemIds: group
      .filter((row) => !row.candidate.taskCorrect)
      .map((row) => row.candidate.itemId),
  };
}

function familyChange(
  equationFamily: MathFamilyId,
  rows: readonly { baseline: SpecializationObservation; candidate: SpecializationObservation }[],
): FamilyChange {
  const group = rows.filter((row) => row.baseline.equationFamily === equationFamily);
  const baselineCorrect = group.filter((row) => row.baseline.taskCorrect).length;
  const candidateCorrect = group.filter((row) => row.candidate.taskCorrect).length;
  const baselineAccuracy = ratio(baselineCorrect, group.length);
  const candidateAccuracy = ratio(candidateCorrect, group.length);
  return {
    equationFamily,
    correct: candidateCorrect,
    sampleSize: group.length,
    accuracy: candidateAccuracy,
    baselineAccuracy,
    candidateAccuracy,
    accuracyChange: candidateAccuracy - baselineAccuracy,
  };
}

function pairItems(
  baseline: readonly SpecializationObservation[],
  candidate: readonly SpecializationObservation[],
):
  | {
      ok: true;
      rows: Array<{ baseline: SpecializationObservation; candidate: SpecializationObservation }>;
    }
  | { ok: false; reason: string } {
  if (baseline.length !== candidate.length) {
    return { ok: false, reason: "Specialization item counts differ." };
  }
  const candidateById = new Map(candidate.map((item) => [item.itemId, item]));
  const rows = [];
  for (const item of baseline) {
    const match = candidateById.get(item.itemId);
    if (!match) {
      return { ok: false, reason: "Specialization item ids differ." };
    }
    if (
      match.skillId !== item.skillId ||
      match.equationFamily !== item.equationFamily ||
      match.templateId !== item.templateId ||
      match.generatorVersion !== item.generatorVersion ||
      match.departmentId !== item.departmentId
    ) {
      return { ok: false, reason: "Specialization labels differ for the same item." };
    }
    rows.push({ baseline: item, candidate: match });
  }
  return { ok: true, rows };
}

function manifestsCompatible(
  left: EvaluationManifest,
  right: EvaluationManifest,
  comparison: ComparisonResult,
): boolean {
  if (comparison.comparable) {
    return true;
  }
  if (comparison.confounders.length > 0) {
    return false;
  }
  const unshared = comparison.missing.filter((path) => !sameUnknown(left, right, path));
  const blocking = comparison.differed.filter(
    (path) => !comparison.allowedDifferences.includes(path),
  );
  return unshared.length === 0 && blocking.length === 0;
}

function sameUnknown(left: EvaluationManifest, right: EvaluationManifest, path: string): boolean {
  const leftValue = readConfig(left, path);
  const rightValue = readConfig(right, path);
  return leftValue?.state === "unknown" && rightValue?.state === "unknown";
}

function readConfig(manifest: EvaluationManifest, path: string): { state: string } | null {
  const [group, field] = path.split(".");
  if (!group || !field) {
    return null;
  }
  const record = manifest[group as keyof EvaluationManifest];
  if (!record || typeof record !== "object") {
    return null;
  }
  const value = record[field as keyof typeof record];
  if (!value || typeof value !== "object" || !("state" in value)) {
    return null;
  }
  return value as { state: string };
}

function emptyComparison(
  reasons: string[],
  manifestComparison: ComparisonResult,
): SpecializationComparison {
  return {
    comparable: false,
    reasons,
    manifestComparison,
    benchmark: {
      contentHash: null,
      generatorVersion: null,
      conditionId: null,
    },
    departmentId: MATH_DEPARTMENT_ID,
    overall: null,
    bySkill: [],
    byFamily: [],
    regressions: [],
    weakSkills: [],
    adapterPerSkill: false,
    memoryWrite: false,
    weightRecalculation: "not_run",
  };
}

function familyIds(items: readonly SpecializationObservation[]): MathFamilyId[] {
  return [...new Set(items.map((item) => item.equationFamily))].sort();
}

function ratio(correct: number, sampleSize: number): number {
  return sampleSize === 0 ? 0 : correct / sampleSize;
}
