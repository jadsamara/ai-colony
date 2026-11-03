import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("migration 0011", () => {
  it("adds only the routing decision table and does not rewrite existing data", () => {
    const sql = readFileSync("packages/database/src/migrations/0011_routing_decisions.sql", "utf8");
    const journal = JSON.parse(readFileSync("packages/database/src/migrations/meta/_journal.json", "utf8")) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const last = journal.entries.at(-1);
    expect(last).toMatchObject({ idx: 11, tag: "0011_routing_decisions", when: 1793553000000 });
    expect(journal.entries.filter((entry) => entry.when > 1793552000000).map((entry) => entry.tag)).toEqual([
      "0011_routing_decisions",
    ]);
    expect(sql).toContain('CREATE TABLE "routing_decisions"');
    expect(sql).toContain("routing_decisions_task_unique");
    expect(sql).toContain("routing_decisions_objective_purpose_unique");
    expect(sql.toLowerCase()).not.toContain("drop table");
    expect(sql.toLowerCase()).not.toContain("delete from");
    expect(sql.toLowerCase()).not.toContain("update ");
    expect(sql.toLowerCase()).not.toContain("alter table");
  });
});
