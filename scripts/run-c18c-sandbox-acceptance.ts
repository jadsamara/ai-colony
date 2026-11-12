/**
 * C1.8C GPU VM acceptance entrypoint.
 *
 * Intended to be run manually over SSH on the Debian GPU VM after `git pull`.
 * Cursor/local agents have no access to that VM — a passing local unit suite
 * does not mean the GPU VM acceptance has been verified.
 *
 * Does not access PostgreSQL, modify Ollama, download model weights, or start GPU training.
 */
import { join } from "node:path";
import { runC18cSandboxAcceptance } from "@ai-colony/core";

const root = join(import.meta.dirname, "..");

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const buildImageIfMissing = !process.argv.includes("--no-build");
  const report = await runC18cSandboxAcceptance({
    repoRoot: root,
    evidenceRoot: join(root, "tmp/c18c-acceptance/evidence"),
    reportPath: join(root, "tmp/c18c-acceptance/acceptance-report.json"),
    buildImageIfMissing,
  });

  process.stdout.write(
    [
      `C1.8C sandbox acceptance ${report.ok ? "PASSED" : "FAILED"}`,
      `host=${report.operatorHost}`,
      `image=${report.image.name} available=${report.image.available} built=${report.image.builtDuringRun}`,
      `dockerIsolationVerified=${report.dockerIsolationVerified}`,
      `productionRepoUnchanged=${report.productionRepoUnchanged}`,
      `sandbox.outcome=${report.sandbox.outcome} failure=${report.sandbox.failureCode ?? "none"}`,
      `report=${join(root, "tmp/c18c-acceptance/acceptance-report.json")}`,
      ...report.checks.map((check) => `check ${check.ok ? "ok" : "FAIL"} ${check.id}: ${check.detail}`),
      ...report.notes,
      "",
    ].join("\n"),
  );

  if (!report.ok) {
    process.exit(2);
  }
}
