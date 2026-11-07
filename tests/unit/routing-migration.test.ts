import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("migration 0011", () => {
  it("adds only the routing decision table and does not rewrite existing data", () => {
    const sql = readFileSync("packages/database/src/migrations/0011_routing_decisions.sql", "utf8");
    const journal = JSON.parse(readFileSync("packages/database/src/migrations/meta/_journal.json", "utf8")) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const routing = journal.entries.find((entry) => entry.tag === "0011_routing_decisions");
    expect(routing).toMatchObject({ idx: 11, tag: "0011_routing_decisions", when: 1793553000000 });
    expect(journal.entries.at(-1)).toMatchObject({ idx: 20, tag: "0020_conversation_integrity", when: 1793562000000 });
    expect(journal.entries.filter((entry) => entry.when > 1793552000000).map((entry) => entry.tag)).toEqual([
      "0011_routing_decisions",
      "0012_dedicated_serving",
      "0013_product_department",
      "0014_efficiency",
      "0015_autonomy",
      "0016_group_conversations",
      "0017_conversation_runtime",
      "0018_conversation_continuity",
      "0019_governed_conversations",
      "0020_conversation_integrity",
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
