import { describe, expect, it } from "vitest";
import { assertDisposableDatabaseUrl, assertReadOnlyInspectionUrl } from "@ai-colony/database";

describe("database target guards", () => {
  it("rejects canonical and docker targets for write-capable tests", () => {
    expect(() => assertDisposableDatabaseUrl("postgres://tester:tester@127.0.0.1:5433/ai_colony_m81")).toThrow(/Refusing/);
    expect(() => assertDisposableDatabaseUrl("postgres://tester:tester@127.0.0.1:5434/other")).toThrow(/Refusing/);
    expect(() => assertDisposableDatabaseUrl("postgres://tester:tester@127.0.0.1:5435/ai_colony")).toThrow(/Refusing/);
  });

  it("allows a disposable database and refuses inspection of port 5434", () => {
    expect(() => assertDisposableDatabaseUrl("postgres://m81:m81@127.0.0.1:5435/ai_colony_m81")).not.toThrow();
    expect(() => assertReadOnlyInspectionUrl("postgres://colony:colony@127.0.0.1:5434/ai_colony")).toThrow(/5434/);
    expect(() => assertReadOnlyInspectionUrl("postgres://colony:colony@127.0.0.1:5433/ai_colony")).not.toThrow();
  });
});
