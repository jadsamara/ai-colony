import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Authorizer, ExperimentService } from "../packages/core/dist/index.js";
import { createDatabase, createPersistence } from "../packages/database/dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !databaseUrl.includes("127.0.0.1:5433")) {
  throw new Error("DATABASE_URL must be the canonical Homebrew database on 127.0.0.1:5433");
}

const root = join(import.meta.dirname, "..");
const { db, close } = createDatabase(databaseUrl);
const persistence = createPersistence(db, close);
const experiments = new ExperimentService(persistence, new Authorizer());
const weight = {
  actor: {
    principalId: "00000000-0000-4000-8000-000000000208",
    principalType: "agent" as const,
    role: "department_agent" as const,
    agentId: "00000000-0000-4000-8000-000000000208",
    departmentId: "00000000-0000-4000-8000-000000000015",
    permissions: ["training:propose", "training:read"],
  },
  correlationId: "m75b-history",
};

const historical = [
  ["self-101-r1-sealed", "verified-rejection-sft", 27, true],
  ["supervised-101-sealed", "lora-supervised", 37, true],
  ["self-202-r1-sealed", "verified-rejection-sft", 38, true],
  ["supervised-202-sealed", "lora-supervised", 29, false],
  ["self-303-r1-sealed", "verified-rejection-sft", 33, true],
  ["supervised-303-sealed", "lora-supervised", 54, true],
] as const;

for (const [id, methodId, correct, retentionOk] of historical) {
  const saved = await experiments.record(weight, {
    idempotencyKey: `m75-history-${id}`,
    methodId,
    modelId: "Qwen/Qwen3-1.7B-MLX-4bit",
    modelRevision: "21457c6f51ed54a7c16e988c0844db973815c137",
    adapterSha256: null,
    problem: "asm3-30 sealed arithmetic",
    datasetSize: 25,
    learningRate: 0.0001,
    steps: 80,
    target: "answer",
    seed: Number(id.replace(/\D/g, "").slice(0, 3)),
    devAccuracy: null,
    baselineAccuracy: 134 / 300,
    sealedAccuracy: correct / 300,
    retentionOk,
    failureClass: "regression",
    recommendation: "Do not repeat the 80-step learning-rate 0.0001 tiny-data configuration.",
    evidencePath: `services/training/results/m75/evals/${id}.jsonl`,
  });
  console.log(`${id} ${saved.repeated ? "already recorded" : saved.experiment.id}`);
}

const development = JSON.parse(readFileSync(join(root, "services/training/results/m75b/development.json"), "utf8")) as {
  baseAccuracy: number;
  measured: Array<{ adapter: { name: string; sha256: string; steps: number; learningRate: number; datasetSize: number; target: "answer" | "structured"; seed: number }; devAccuracy: number; retentionAccuracy: number; severe: boolean }>;
};
for (const row of development.measured) {
  const saved = await experiments.record(weight, {
    idempotencyKey: `m75b-${row.adapter.name}`,
    methodId: row.adapter.target === "structured" ? "structured-solution-sft" : "lora-supervised",
    modelId: "Qwen/Qwen3-1.7B-MLX-4bit",
    modelRevision: "21457c6f51ed54a7c16e988c0844db973815c137",
    adapterSha256: row.adapter.sha256,
    problem: "asm3-30 development stability",
    datasetSize: row.adapter.datasetSize,
    learningRate: row.adapter.learningRate,
    steps: row.adapter.steps,
    target: row.adapter.target,
    seed: row.adapter.seed,
    devAccuracy: row.devAccuracy,
    baselineAccuracy: development.baseAccuracy,
    sealedAccuracy: null,
    retentionOk: row.retentionAccuracy >= development.baseAccuracy - 0.15,
    failureClass: row.severe ? "regression" : null,
    recommendation: "Keep the adapter experimental.",
    evidencePath: `services/training/results/m75b/training/${row.adapter.name}.json`,
  });
  console.log(`${row.adapter.name} ${saved.repeated ? "already recorded" : saved.experiment.id}`);
}

const plan = await experiments.plan(weight, { problem: "asm3-30 arithmetic regression", baseAccuracy: 134 / 300, budgetMaxSteps: 40 });
const rejected = plan.recommendations.find((item) => item.action === "reject-configuration");
console.log(`planner cited ${rejected?.citedExperimentIds.length ?? 0} historical regressions`);
await close();
