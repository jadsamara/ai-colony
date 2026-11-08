import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("migration journal", () => {
  it("keeps routing 0011 additive and registers claim migrations 0027/0028 in order", () => {
    const sql = readFileSync("packages/database/src/migrations/0011_routing_decisions.sql", "utf8");
    const journal = JSON.parse(readFileSync("packages/database/src/migrations/meta/_journal.json", "utf8")) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const tags = journal.entries.map((entry) => entry.tag);
    const byTag = new Map(journal.entries.map((entry) => [entry.tag, entry]));

    expect(byTag.get("0011_routing_decisions")).toMatchObject({
      idx: 11,
      tag: "0011_routing_decisions",
      when: 1793553000000,
    });

    for (const [index, entry] of journal.entries.entries()) {
      expect(entry.idx).toBe(index);
      if (index > 0) {
        expect(entry.when).toBeGreaterThanOrEqual(journal.entries[index - 1]!.when);
      }
    }

    const required = [
      "0011_routing_decisions",
      "0026_department_join_requests",
      "0027_conversation_claims",
      "0028_claim_idempotency",
    ] as const;
    for (const tag of required) {
      expect(tags, `missing journal entry ${tag}`).toContain(tag);
      expect(existsSync(`packages/database/src/migrations/${tag}.sql`), `missing SQL for ${tag}`).toBe(true);
    }

    expect(tags.indexOf("0011_routing_decisions")).toBeLessThan(tags.indexOf("0026_department_join_requests"));
    expect(tags.indexOf("0026_department_join_requests")).toBeLessThan(tags.indexOf("0027_conversation_claims"));
    expect(tags.indexOf("0027_conversation_claims")).toBeLessThan(tags.indexOf("0028_claim_idempotency"));

    const tip = journal.entries.at(-1);
    expect(tip).toBeDefined();
    expect(tip!.idx).toBe(journal.entries.length - 1);
    expect(tip!.tag).toBe(tags.at(-1));
    // Tip must remain the chronologically latest registered migration without hardcoding its number.
    expect(tip!.when).toBe(Math.max(...journal.entries.map((entry) => entry.when)));

    const onDisk = readdirSync("packages/database/src/migrations")
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();
    expect(tags.slice().sort()).toEqual(onDisk);

    expect(sql).toContain('CREATE TABLE "routing_decisions"');
    expect(sql).toContain("routing_decisions_task_unique");
    expect(sql).toContain("routing_decisions_objective_purpose_unique");
    expect(sql.toLowerCase()).not.toContain("drop table");
    expect(sql.toLowerCase()).not.toContain("delete from");
    expect(sql.toLowerCase()).not.toContain("update ");
    expect(sql.toLowerCase()).not.toContain("alter table");

    const claimsSql = readFileSync("packages/database/src/migrations/0027_conversation_claims.sql", "utf8");
    expect(claimsSql).toContain('CREATE TABLE "conversation_claims"');
    expect(claimsSql).toContain('CREATE TABLE "conversation_claim_verifications"');
    expect(claimsSql.toLowerCase()).not.toContain("drop table");

    const idempotencySql = readFileSync("packages/database/src/migrations/0028_claim_idempotency.sql", "utf8");
    expect(idempotencySql.toLowerCase()).toMatch(/idempotency/);
    expect(idempotencySql.toLowerCase()).not.toContain("drop table");
  });
});
