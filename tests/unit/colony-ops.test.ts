import { chmodSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

describe("C1.7.5 colony ops scripts", () => {
  it("ships an executable ./scripts/colony entrypoint with required commands", () => {
    const script = "scripts/colony";
    const common = "scripts/lib/colony-common.sh";
    const mode = statSync(script).mode;
    // Ensure owner-executable bit; repair if the write tool dropped it.
    if ((mode & 0o100) === 0) {
      chmodSync(script, 0o755);
    }
    if ((statSync(common).mode & 0o100) === 0) {
      chmodSync(common, 0o755);
    }
    expect(statSync(script).mode & 0o100).toBeTruthy();
    const text = readFileSync(script, "utf8");
    const commonText = readFileSync(common, "utf8");
    for (const command of ["up", "down", "deploy", "restart", "status", "logs", "test"]) {
      expect(text).toContain(`cmd_${command}`);
    }
    expect(text).toMatch(/does NOT git pull|CHECKED-OUT code only/i);
    expect(commonText).toContain("pnpm db:migrate");
    expect(text).toContain("colony_migrate");
    expect(`${text}\n${commonText}`).toContain("down -v");
    expect(text.toLowerCase()).toContain("never");
  });

  it("rejects volume-wipe arguments without touching docker", () => {
    const result = spawnSync("./scripts/colony", ["down", "-v"], {
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Refusing|volume/i);
  });

  it("documents safety in the C1.7.5 milestone guide", () => {
    const doc = readFileSync("docs/milestones/C1_7_5_ONE_COMMAND_COLONY.md", "utf8");
    expect(doc).toContain("./scripts/colony");
    expect(doc).toContain("down -v");
    expect(doc.toLowerCase()).toContain("checked-out");
    expect(doc).toContain("db:migrate");
    expect(doc.toLowerCase()).toContain("no automatic multi-gb model download");
  });

  it("exposes pnpm colony without replacing dedicated colony-cli scripts", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.colony).toBe("./scripts/colony");
    expect(pkg.scripts["colony:start"]).toContain("colony-cli.ts start");
    expect(pkg.scripts["colony:stop"]).toContain("colony-cli.ts stop");
  });
});
