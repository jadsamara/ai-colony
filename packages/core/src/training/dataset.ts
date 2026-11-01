import { createHash } from "node:crypto";
import type { AcceptanceCriteria } from "@ai-colony/contracts";

export const ACCEPTANCE_CRITERIA: AcceptanceCriteria = {
  metric: "numeric_correctness",
  requireStrictImprovement: true,
  minStructuredValidity: 1,
  ignoreTrainingLoss: true,
};

export type ExampleSplit = "train" | "validation" | "test";
export type ExampleSource = "curated_arithmetic" | "supplied" | "memory" | "objective_trace";

export interface DraftExample {
  groupKey: string;
  source: ExampleSource;
  license: string;
  input: string;
  expectedOutput: string;
  validationStatus: "verified";
  sourceMemoryId: string | null;
  sourceObjectiveId: string | null;
}

export interface AssignedExample extends DraftExample {
  split: ExampleSplit;
  contentHash: string;
}

export interface RejectedExample {
  input: string;
  reason: string;
}

const ARITHMETIC = /(-?\d+)\s*([+*])\s*(-?\d+)/;

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseArithmetic(input: string): { input: string; expectedOutput: string; groupKey: string } | null {
  const match = ARITHMETIC.exec(input);
  if (!match) {
    return null;
  }
  const left = Number(match[1]);
  const right = Number(match[3]);
  const op = match[2] as "+" | "*";
  if (!Number.isInteger(left) || !Number.isInteger(right)) {
    return null;
  }
  const a = Math.min(left, right);
  const b = Math.max(left, right);
  const expected = op === "+" ? a + b : a * b;
  return {
    input: `${a} ${op} ${b}`,
    expectedOutput: String(expected),
    groupKey: `${op}:${a}:${b}`,
  };
}

export function assignSplit(groupKey: string, seed: number): ExampleSplit {
  const bucket = createHash("sha256").update(`${seed}:${groupKey}`).digest()[0]! % 10;
  if (bucket <= 6) {
    return "train";
  }
  if (bucket <= 8) {
    return "validation";
  }
  return "test";
}

export function applyReserved<T extends { groupKey: string; split: ExampleSplit }>(
  rows: T[],
  reservedTestGroups: ReadonlySet<string>,
): T[] {
  return rows.map((row) => (reservedTestGroups.has(row.groupKey) ? { ...row, split: "test" } : row));
}

export function assertDisjoint(rows: Array<{ groupKey: string; split: ExampleSplit }>): void {
  const seen = new Map<string, ExampleSplit>();
  for (const row of rows) {
    const prior = seen.get(row.groupKey);
    if (prior && prior !== row.split) {
      throw new Error(`group ${row.groupKey} crosses splits`);
    }
    seen.set(row.groupKey, row.split);
  }
}

function arithmeticAt(index: number): DraftExample {
  const a = index % 17;
  const b = Math.floor(index / 17) % 17;
  const op = Math.floor(index / (17 * 17)) % 2 === 0 ? "+" : "*";
  const parsed = parseArithmetic(`${a} ${op} ${b}`);
  if (!parsed) {
    throw new Error("curated arithmetic failed to verify");
  }
  return {
    ...parsed,
    source: "curated_arithmetic",
    license: "colony-curated-deterministic",
    validationStatus: "verified",
    sourceMemoryId: null,
    sourceObjectiveId: null,
  };
}

export function buildCuratedArithmetic(count: number, seed: number): AssignedExample[] {
  const rows: AssignedExample[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (rows.length < count && index < 2000) {
    const draft = arithmeticAt(index);
    index += 1;
    if (seen.has(draft.groupKey)) {
      continue;
    }
    seen.add(draft.groupKey);
    rows.push(assign(draft, seed));
  }
  const minimums: Record<ExampleSplit, number> = { train: 8, validation: 4, test: 4 };
  while (index < 2000 && (["train", "validation", "test"] as const).some((split) => rows.filter((row) => row.split === split).length < minimums[split])) {
    const draft = arithmeticAt(index);
    index += 1;
    if (seen.has(draft.groupKey)) {
      continue;
    }
    seen.add(draft.groupKey);
    rows.push(assign(draft, seed));
  }
  return rows;
}

export function examplesFromSupplied(
  inputs: string[],
  seed: number,
): { accepted: AssignedExample[]; rejected: RejectedExample[] } {
  const accepted: AssignedExample[] = [];
  const rejected: RejectedExample[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const parsed = parseArithmetic(input);
    if (!parsed) {
      rejected.push({ input, reason: "unverified_expression" });
      continue;
    }
    if (seen.has(parsed.groupKey)) {
      rejected.push({ input, reason: "near_duplicate" });
      continue;
    }
    seen.add(parsed.groupKey);
    accepted.push(
      assign(
        {
          ...parsed,
          source: "supplied",
          license: "caller-supplied-verified",
          validationStatus: "verified",
          sourceMemoryId: null,
          sourceObjectiveId: null,
        },
        seed,
      ),
    );
  }
  return { accepted, rejected };
}

export function exampleFromMemory(
  memory: { id: string; status: string; provenance: string; content: string },
  seed: number,
): { example: AssignedExample } | { rejected: RejectedExample } {
  if (memory.provenance === "model_generated") {
    return { rejected: { input: memory.id, reason: "model_generated" } };
  }
  if (memory.status !== "validated") {
    return { rejected: { input: memory.id, reason: "not_validated" } };
  }
  if (memory.provenance !== "user_provided" && memory.provenance !== "externally_verified" && memory.provenance !== "system_observed") {
    return { rejected: { input: memory.id, reason: "provenance" } };
  }
  const labeled = /^INPUT:\s*(.+)\nOUTPUT:\s*(-?\d+)\s*$/m.exec(memory.content);
  if (!labeled) {
    return { rejected: { input: memory.id, reason: "unverified" } };
  }
  const parsed = parseArithmetic(labeled[1] ?? "");
  if (!parsed || parsed.expectedOutput !== labeled[2]) {
    return { rejected: { input: memory.id, reason: "output_mismatch" } };
  }
  return {
    example: assign(
      {
        ...parsed,
        source: "memory",
        license: "validated-memory",
        validationStatus: "verified",
        sourceMemoryId: memory.id,
        sourceObjectiveId: null,
      },
      seed,
    ),
  };
}

export function exampleFromObjective(
  objective: { id: string; status: string },
  input: string,
  seed: number,
): { example: AssignedExample } | { rejected: RejectedExample } {
  if (objective.status !== "completed") {
    return { rejected: { input, reason: "objective_not_completed" } };
  }
  const parsed = parseArithmetic(input);
  if (!parsed) {
    return { rejected: { input, reason: "unverified_expression" } };
  }
  return {
    example: assign(
      {
        ...parsed,
        source: "objective_trace",
        license: "completed-objective-recomputed",
        validationStatus: "verified",
        sourceMemoryId: null,
        sourceObjectiveId: objective.id,
      },
      seed,
    ),
  };
}

export function versionHash(rows: AssignedExample[]): string {
  return sha256Text(rows.map((row) => row.contentHash).sort().join("\n"));
}

export function toMessagesJsonl(rows: Array<{ input: string; expectedOutput: string }>): string {
  return rows
    .map((row) =>
      JSON.stringify({
        messages: [
          { role: "user", content: row.input },
          { role: "assistant", content: row.expectedOutput },
        ],
      }),
    )
    .join("\n")
    .concat("\n");
}

export function trainingRows(rows: AssignedExample[]): AssignedExample[] {
  return rows.filter((row) => row.split !== "test");
}

function assign(draft: DraftExample, seed: number): AssignedExample {
  const contentHash = sha256Text(`${draft.groupKey}\n${draft.input}\n${draft.expectedOutput}`);
  return { ...draft, split: assignSplit(draft.groupKey, seed), contentHash };
}
