/**
 * C1.8A single-agent Math baseline against base Qwen3:8b.
 * Reads the frozen suite, calls Ollama, and writes a report file.
 * Does not train, migrate, seed, or modify department models.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import { runMathBaseline, verifyFrozenMathSuite, type MathBaselineReport } from "@ai-colony/core";
import { OllamaStatusClient, OpenAICompatibleProvider } from "@ai-colony/inference";

const root = join(import.meta.dirname, "..");
const suitePath = join(root, "packages/core/src/evaluation/fixtures/c18a-math-suite-v1.json");
const outputPath =
  process.env.C18A_OUT ?? join(root, "services/evaluation/c18a/baseline-report.json");
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const alias = process.env.C18A_MODEL_ALIAS ?? "qwen3:8b";

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const suite = verifyFrozenMathSuite(JSON.parse(readFileSync(suitePath, "utf8")));
  const status = new OllamaStatusClient({ baseUrl, timeoutMs: 5_000, minIntervalMs: 0 });
  const probe = await status.inspect();
  if (!probe.reachable) {
    throw new Error(`Ollama is not reachable at ${baseUrl}`);
  }
  const installed = probe.installed.find((model) => model.name === alias);
  if (!installed) {
    throw new Error(`Ollama does not have ${alias}. This runner does not pull or replace models.`);
  }
  const shared = { baseUrl, apiKey: null, maxConcurrency: 1, transportRetries: 1 };
  const report = await runMathBaseline({
    suite,
    gitCommit: gitCommit(),
    environment: "single-agent-ollama",
    model: {
      family: "qwen3",
      alias,
      registryModelId: QWEN3_8B_MODEL_ID,
      weightsVersion: "base",
      adapterId: null,
      installedDigest: installed.digest,
      backendId: "ollama",
      backendVersion: probe.version,
    },
    providers: {
      standard: new OpenAICompatibleProvider({ ...shared, reasoningEffort: "none" }),
      fewShotThinking: new OpenAICompatibleProvider({ ...shared, reasoningEffort: null }),
      toolAssisted: new OpenAICompatibleProvider({ ...shared, reasoningEffort: "none" }),
    },
  });
  writeReport(report);
  const lines = report.conditions.map(
    (condition) => `${condition.conditionId} ${condition.correct}/${condition.sampleSize}`,
  );
  const standard = report.conditions.find((condition) => condition.conditionId === "standard");
  const skills = (standard?.specialization.bySkill ?? []).map(
    (skill) => `standard ${skill.skillId} ${skill.correct}/${skill.sampleSize}`,
  );
  process.stdout.write(
    `C1.8A math baseline written to ${outputPath}\n${[...lines, ...skills].join("\n")}\n`,
  );
}

function writeReport(report: MathBaselineReport): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function gitCommit(): string | null {
  try {
    const value = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    return /^[0-9a-f]{7,64}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}
