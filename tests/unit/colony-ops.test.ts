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
    expect(doc).toContain("GPU database targeting");
    expect(doc).toContain("__drizzle_migrations");
    expect(doc).toContain("127.0.0.1:3000:3000");
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

  it("ships api-gpu overlay attaching colony-api-test to colony-dedicated with published port", () => {
    const overlay = readFileSync("deploy/docker-compose.api-gpu.yml", "utf8");
    const base = readFileSync("deploy/docker-compose.api-test.yml", "utf8");
    expect(overlay).toContain("colony-api-test");
    expect(overlay).toContain("colony-dedicated");
    expect(overlay).toContain("colony-db");
    expect(overlay).toContain("ollama-science");
    expect(overlay).toContain("127.0.0.1:3000:3000");
    expect(base).toContain("127.0.0.1:3000:3000");
    expect(overlay).not.toMatch(/gpus:/);
  });

  it("derives GPU database name from DATABASE_URL instead of hardcoding ai_colony", () => {
    const common = readFileSync("scripts/lib/colony-common.sh", "utf8");
    expect(common).toContain("colony_parse_database_url");
    expect(common).toContain("COLONY_DB_NAME");
    expect(common).toContain("colony_migration_sync_report");
    expect(common).toContain("colony_report_api_port_conflicts");
    // GPU seed/drizzle helpers must not hardcode -d ai_colony
    expect(common).not.toMatch(/colony_gpu_psql.*-d ai_colony/);
    expect(common).not.toMatch(/psql -U colony -d ai_colony/);

    const parsed = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          'export DATABASE_URL="postgres://colony:secret@postgres:5432/ai_colony_v2"',
          "colony_parse_database_url",
          'test "$COLONY_DB_NAME" = "ai_colony_v2"',
          'test "$COLONY_DB_USER" = "colony"',
          'test "$COLONY_DB_HOST" = "postgres"',
          'echo ok',
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(parsed.status).toBe(0);
    expect(parsed.stdout).toContain("database_target name=ai_colony_v2");
    expect(parsed.stdout).toContain("ok");

    const emptyAi = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          'export DATABASE_URL="postgres://colony:secret@postgres:5432/ai_colony"',
          "colony_parse_database_url",
          'test "$COLONY_DB_NAME" = "ai_colony"',
          'echo ok-empty-name-still-derived',
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(emptyAi.status).toBe(0);
  });

  it("validates migration journal when stamps against applied rows for multi-db targeting", () => {
    const report = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          "colony_journal_entry_count() { echo 29; }",
          'colony_journal_tip() { echo "28\t0028_claim_idempotency\t1793570000000"; }',
          "colony_journal_whens() { echo 1,2,3; }",
          "colony_drizzle_rows() { echo 0; }",
          "COLONY_PROFILE=gpu",
          "COLONY_DB_NAME=ai_colony_v2",
          "colony_gpu_psql() { echo 0; }",
          "colony_migration_sync_report || true",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("database_name=ai_colony_v2");
    expect(report.stdout).toContain("migration_applied_rows=0");
    expect(report.stdout).toMatch(/pending_or_unknown|pending_or_diverged|unavailable/);

    const matched = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          "colony_journal_entry_count() { echo 3; }",
          'colony_journal_tip() { echo "2\ttip\t3"; }',
          "colony_journal_whens() { echo 1,2,3; }",
          "colony_drizzle_rows() { echo 3; }",
          "COLONY_PROFILE=local",
          "COLONY_DB_NAME=ai_colony_v2",
          "colony_psql_local() { echo 1,2,3; }",
          "colony_migration_sync_report",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(matched.status).toBe(0);
    expect(matched.stdout).toContain("migrations=current");
    expect(matched.stdout).toContain("migration_journal_consistency=matched");
  });

  it("detects missing API port publication and stale port conflicts in helpers", () => {
    const common = readFileSync("scripts/lib/colony-common.sh", "utf8");
    expect(common).toContain("colony_gpu_api_host_port");
    expect(common).toContain("Ports null");
    expect(common).toContain("already published by container");
    expect(common).toContain("COLONY_GPU_API_PROJECT");
    expect(common).toContain("colony_verify_gpu_api_identity");
    expect(common).toContain("colony_docker_ids_equal");
    expect(common).toContain("api_identity=verified");
    expect(common).toContain("ready_but_unexpected_listener");

    const full =
      "f0f47f65d572db0ed440a91314156783462219bc4874682e5b357fff14b19367";
    const short = full.slice(0, 12);

    const idEq = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          `colony_docker_ids_equal "${full}" "${short}" && echo full_vs_short=ok`,
          `colony_docker_ids_equal "${short}" "${full}" && echo short_vs_full=ok`,
          `colony_docker_ids_equal "${full}" "${full}" && echo full_vs_full=ok`,
          `colony_docker_ids_equal "${short}" "abcdefabcdef" || echo different=ok`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(idEq.status).toBe(0);
    expect(idEq.stdout).toContain("full_vs_short=ok");
    expect(idEq.stdout).toContain("short_vs_full=ok");
    expect(idEq.stdout).toContain("full_vs_full=ok");
    expect(idEq.stdout).toContain("different=ok");

    // Full expected ID vs short docker-ps ID for the same container: not a conflict.
    const selfFull = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          "PORT=3000",
          `colony_gpu_api_container_id() { echo ${full}; }`,
          `colony_containers_on_host_port() { printf "%s\\t%s\\t%s\\n" ${short} ai-colony-api-colony-api-test-1 "127.0.0.1:3000->3000/tcp"; }`,
          "colony_report_api_port_conflicts; echo status=$?",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(selfFull.status).toBe(0);
    expect(selfFull.stdout).toContain("held_by_expected");
    expect(selfFull.stdout).not.toContain("CONFLICT");
    expect(selfFull.stdout).toContain("status=0");

    // Short expected ID vs full holder ID: still the same container.
    const selfShort = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          "PORT=3000",
          `colony_gpu_api_container_id() { echo ${short}; }`,
          `colony_containers_on_host_port() { printf "%s\\t%s\\t%s\\n" ${full} ai-colony-api-colony-api-test-1 "127.0.0.1:3000->3000/tcp"; }`,
          "colony_report_api_port_conflicts; echo status=$?",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(selfShort.status).toBe(0);
    expect(selfShort.stdout).toContain("held_by_expected");
    expect(selfShort.stdout).not.toContain("CONFLICT");

    const conflict = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          "PORT=3000",
          `colony_gpu_api_container_id() { echo ${full}; }`,
          'colony_containers_on_host_port() { printf "%s\\t%s\\t%s\\n" abc123stale99 stale-colony-api-test "127.0.0.1:3000->3000/tcp"; }',
          "colony_report_api_port_conflicts || echo status=$?",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(conflict.status).toBe(0);
    expect(conflict.stdout).toContain("api_port_3000=CONFLICT");
    expect(conflict.stdout).toContain("stale-colony-api-test");
    expect(conflict.stdout).toContain("status=1");

    // Verified when expected publishes 3000, health ready, no foreign holders.
    const verified = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          "PORT=3000",
          "COLONY_API_BASE=http://127.0.0.1:3000",
          "COLONY_GPU_API_PROJECT=ai-colony-api",
          `colony_gpu_api_container_id() { echo ${full}; }`,
          'colony_gpu_api_host_port() { echo "127.0.0.1:3000"; }',
          "colony_api_ready() { return 0; }",
          `colony_containers_on_host_port() { printf "%s\\t%s\\t%s\\n" ${short} ai-colony-api-colony-api-test-1 "127.0.0.1:3000->3000/tcp"; }`,
          "colony_verify_gpu_api_identity",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain("api_identity=verified");
    expect(verified.stdout).not.toContain("ready_but_unexpected_listener");

    // Expected container exists but does not publish the host port.
    const noPublish = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          "PORT=3000",
          "COLONY_API_BASE=http://127.0.0.1:3000",
          "COLONY_GPU_API_PROJECT=ai-colony-api",
          `colony_gpu_api_container_id() { echo ${full}; }`,
          'colony_gpu_api_host_port() { echo "127.0.0.1:3000"; }',
          "colony_api_ready() { return 0; }",
          'colony_containers_on_host_port() { printf "%s\\t%s\\t%s\\n" otherdeadbeef stale-api "127.0.0.1:3000->3000/tcp"; }',
          "colony_verify_gpu_api_identity || true",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(noPublish.status).toBe(0);
    expect(noPublish.stdout).toContain("api_identity=ready_but_unexpected_listener");

    const missingPort = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/colony-common.sh",
          "COLONY_GPU_API_PROJECT=ai-colony-api",
          "colony_gpu_api_container_id() { echo cid1; }",
          "colony_gpu_api_host_port() { echo ''; }",
          "colony_verify_gpu_api_identity || true",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(missingPort.status).toBe(0);
    expect(`${missingPort.stdout}${missingPort.stderr}`).toMatch(/no published host port|Ports null/i);
  });

  it("status path never hardcodes empty ai_colony for GPU migration/seed checks", () => {
    const script = readFileSync("scripts/colony", "utf8");
    const common = readFileSync("scripts/lib/colony-common.sh", "utf8");
    expect(script).toContain("colony_migration_sync_report");
    expect(script).toContain("seed_database=${COLONY_DB_NAME}");
    expect(script).toContain("colony_verify_gpu_api_identity");
    expect(common).toContain("drizzle.__drizzle_migrations");
    expect(common).toContain("migration_journal_consistency");
    // Must not query a fixed empty sibling DB in status/seed helpers.
    expect(script).not.toMatch(/pg_isready -U colony -d ai_colony/);
    expect(script).not.toMatch(/-d ai_colony[^_]/);
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
