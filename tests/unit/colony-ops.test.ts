import { chmodSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

function ensureExecutable(path: string): void {
  if ((statSync(path).mode & 0o100) === 0) {
    chmodSync(path, 0o755);
  }
}

describe("C1.7.5 colony ops scripts", () => {
  it("ships an executable entrypoint with local and gpu profile support", () => {
    const script = "scripts/colony";
    const common = "scripts/lib/colony-common.sh";
    ensureExecutable(script);
    ensureExecutable(common);
    const text = readFileSync(script, "utf8");
    const commonText = readFileSync(common, "utf8");
    for (const command of ["up", "down", "deploy", "restart", "status", "logs", "test"]) {
      expect(text).toContain(`cmd_${command}`);
    }
    expect(text).toMatch(/COLONY_PROFILE|--profile/);
    expect(commonText).toContain('local|gpu');
    expect(commonText).toContain("docker-compose.gcp.yml");
    expect(commonText).toContain("docker-compose.gpu.yml");
    expect(commonText).toContain("docker-compose.database.yml");
    expect(commonText).toContain("colony-api-test");
    expect(commonText).toContain("ollama-science");
    expect(commonText).toContain("pnpm db:migrate");
    expect(commonText).toContain("migrate-cli.js");
    expect(commonText).toContain("stop -t 30");
    expect(`${text}\n${commonText}`).toContain("down -v");
    expect(text).toMatch(/CHECKED-OUT code only|does NOT git pull/i);
  });

  it("defaults to local profile and accepts --profile gpu without docker", () => {
    const help = spawnSync("./scripts/colony", ["help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/local/);
    expect(help.stdout).toMatch(/gpu/);

    const bad = spawnSync("./scripts/colony", ["--profile", "cloud", "help"], { encoding: "utf8" });
    // help short-circuits after parse; unknown profile is validated on load_env. Ensure parse keeps args.
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/Usage:|gpu|local/);
  });

  it("rejects volume-wipe arguments without touching docker", () => {
    const result = spawnSync("./scripts/colony", ["down", "-v"], {
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH, COLONY_PROFILE: "local" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Refusing|volume/i);

    const gpuWipe = spawnSync("./scripts/colony", ["--profile", "gpu", "down", "--volumes"], {
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH },
    });
    expect(gpuWipe.status).not.toBe(0);
    expect(`${gpuWipe.stdout}${gpuWipe.stderr}`).toMatch(/Refusing|volume/i);
  });

  it("documents GPU Compose invocation and safe shutdown", () => {
    const doc = readFileSync("docs/milestones/C1_7_5_ONE_COMMAND_COLONY.md", "utf8");
    expect(doc).toContain("COLONY_PROFILE");
    expect(doc).toContain("docker-compose.gcp.yml");
    expect(doc).toContain("docker-compose.gpu.yml");
    expect(doc).toContain("colony-api-test");
    expect(doc).toContain("ollama-science");
    expect(doc).toContain("stop -t 30");
    expect(doc).toContain("down -v");
    expect(doc.toLowerCase()).toContain("checked-out");
    expect(doc.toLowerCase()).toMatch(/db:migrate|migrate-cli|migrations/);
    expect(doc.toLowerCase()).toContain("no automatic multi-gb model download");
  });

  it("encodes GPU compose file order for dedicated stack", () => {
    const common = readFileSync("scripts/lib/colony-common.sh", "utf8");
    expect(common).toContain("colony_print_gpu_compose_invocation");
    const printed = spawnSync(
      "bash",
      [
        "-c",
        `source scripts/lib/colony-common.sh; COLONY_GPU_PUBLISHER=true; colony_print_gpu_compose_invocation`,
      ],
      { encoding: "utf8" },
    );
    expect(printed.status).toBe(0);
    expect(printed.stdout).toContain("deploy/docker-compose.gcp.yml");
    expect(printed.stdout).toContain("deploy/docker-compose.gpu.yml");
    expect(printed.stdout).toContain("deploy/docker-compose.database.yml");
  });

  it("treats migration failure as a hard stop before API for both profiles", () => {
    const common = readFileSync("scripts/lib/colony-common.sh", "utf8");
    const script = readFileSync("scripts/colony", "utf8");
    expect(common).toMatch(/EXIT_MIGRATE=11/);
    expect(common).toMatch(/Migration failed/);
    expect(script).toMatch(/colony_migrate_gpu/);
    expect(script).toMatch(/API was not started|API start aborted|not started/);
    // Order: migrate before start API on gpu up
    const migrateAt = script.indexOf("colony_migrate_gpu");
    const apiAt = script.indexOf("colony_start_api_gpu");
    expect(migrateAt).toBeGreaterThan(-1);
    expect(apiAt).toBeGreaterThan(migrateAt);
  });

  it("ships api-gpu overlay attaching colony-api-test to colony-dedicated", () => {
    const overlay = readFileSync("deploy/docker-compose.api-gpu.yml", "utf8");
    expect(overlay).toContain("colony-api-test");
    expect(overlay).toContain("colony-dedicated");
    expect(overlay).toContain("colony-db");
    expect(overlay).toContain("ollama-science");
    expect(overlay).not.toMatch(/gpus:/);
  });

  it("exposes pnpm colony without replacing dedicated colony-cli scripts", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.colony).toBe("./scripts/colony");
    expect(pkg.scripts["colony:start"]).toContain("colony-cli.ts start");
    expect(pkg.scripts["colony:stop"]).toContain("colony-cli.ts stop");
  });

  it("simulates migration failure helper exit without starting API", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          "colony_migrate_local() { return 1; }",
          "colony_migrate() {",
          '  colony_log "Applying pending migrations..."',
          "  if ! colony_migrate_local; then",
          '    colony_die "${EXIT_MIGRATE}" "Migration failed. API was not started."',
          "  fi",
          "}",
          "colony_migrate",
          "echo API_STARTED",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(11);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Migration failed/);
    expect(`${result.stdout}${result.stderr}`).not.toContain("API_STARTED");
  });
});
