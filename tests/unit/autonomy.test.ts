import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acceptGoalEvidence, normalizeGoal, redactSensitive } from "../../packages/core/src/autonomy/policy.js";
import { ROLE_PERMISSIONS } from "../../packages/core/src/governance/permissions.js";
import { chooseDispatch } from "../../packages/core/src/objectives/schedule.js";
import { routeObjective } from "../../packages/core/src/objectives/efficiency.js";

describe("autonomous goal policy", () => {
  it("accepts evidence only when it quotes an observation", () => {
    const observations = ["failed objectives: 2", "stored memories: 4"];
    expect(acceptGoalEvidence(["observed: failed objectives: 2"], observations)).toBe(true);
    expect(acceptGoalEvidence(["observed: the math department is broken"], observations)).toBe(false);
    expect(acceptGoalEvidence([], observations)).toBe(false);
    expect(acceptGoalEvidence(["failed objectives: 2"], observations)).toBe(false);
  });

  it("normalizes goal text and redacts credentials", () => {
    expect(normalizeGoal("  Improve   Physics ")).toBe("improve physics");
    expect(redactSensitive("postgres://user:secret@localhost/ai_colony and Bearer abc.def")).toBe(
      "[redacted] and Bearer [redacted]",
    );
  });

  it("keeps colony-wide goal authority with the administrator", () => {
    expect(ROLE_PERMISSIONS.system_administrator.has("autonomy:manage")).toBe(true);
    expect(ROLE_PERMISSIONS.ceo_agent.has("autonomy:manage")).toBe(false);
    expect(ROLE_PERMISSIONS.ceo_agent.has("objective:submit")).toBe(false);
    expect(ROLE_PERMISSIONS.department_agent.has("autonomy:manage")).toBe(false);
    expect(ROLE_PERMISSIONS.department_agent.has("objective:submit")).toBe(false);
    expect(ROLE_PERMISSIONS.department_agent.has("message:publish")).toBe(true);
  });

  it("schedules human work ahead of autonomous work", () => {
    const selected = chooseDispatch(
      [
        task("auto", "autonomous", 1, "2026-01-01T00:00:00.000Z"),
        task("human", "human", 0, "2026-01-02T00:00:00.000Z"),
      ],
      {
        globalInflight: 0,
        globalLimit: 1,
        perObjective: 2,
        perDepartment: 2,
        inflightByObjective: {},
        inflightByDepartment: {},
      },
    );
    expect(selected).toEqual(["human"]);
  });

  it("keeps a closed arithmetic prompt on the direct path", () => {
    expect(routeObjective("Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer.")).toMatchObject({
      path: "direct",
      departments: ["math"],
    });
  });

  it("keeps the postgres pool bounded", () => {
    expect(readFileSync("packages/database/src/client.ts", "utf8")).toMatch(/max:\s*3/);
  });
});

function task(id: string, objectiveId: string, schedulingRank: number, createdAt: string) {
  return {
    id,
    objectiveId,
    departmentId: id,
    status: "ready",
    dependsOn: [],
    objectiveCreatedAt: createdAt,
    createdAt,
    schedulingRank,
  };
}
