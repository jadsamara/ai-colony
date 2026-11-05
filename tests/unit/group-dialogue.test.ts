import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDialogueContext, estimateTokens, maySpeak, selectSpeaker } from "../../packages/core/src/autonomy/speakers.js";
import { ROLE_PERMISSIONS } from "../../packages/core/src/governance/permissions.js";
import { routeObjective } from "../../packages/core/src/objectives/efficiency.js";
import { chooseDispatch } from "../../packages/core/src/objectives/schedule.js";

const math = { id: "math", slug: "math", name: "Math" };
const science = { id: "science", slug: "science", name: "Science" };
const research = { id: "research", slug: "research", name: "Research" };
const reasoning = { id: "reasoning", slug: "reasoning", name: "Reasoning" };

describe("group conversation scheduling", () => {
  it("selects the department named by the latest question", () => {
    const choice = selectSpeaker({
      participants: [science, math, research],
      turns: [
        {
          departmentId: science.id,
          departmentSlug: "science",
          kind: "question",
          body: "Math, does this quantity hold?",
          addressedDepartmentId: math.id,
        },
      ],
      topic: "Unfamiliar physics problems",
      remainingMessages: 8,
    });
    expect(choice).toEqual({ departmentId: "math", slug: "math", reason: "directed" });
  });

  it("prefers expertise and a department that has not spoken", () => {
    const choice = selectSpeaker({
      participants: [science, math, research, reasoning],
      turns: [
        {
          departmentId: science.id,
          departmentSlug: "science",
          kind: "proposal",
          body: "We need a citation before changing the experiment.",
          addressedDepartmentId: null,
        },
      ],
      topic: "Improve the physics check",
      remainingMessages: 6,
    });
    expect(choice?.departmentId).toBe("research");
    expect(choice?.reason).toBe("expertise");
  });

  it("does not let the last speaker take another turn while someone else has spoken less", () => {
    const turns = [
      { departmentId: "science", departmentSlug: "science", kind: "question", body: "Check this.", addressedDepartmentId: "math" },
      { departmentId: "math", departmentSlug: "math", kind: "response", body: "It fails.", addressedDepartmentId: null },
    ];
    expect(maySpeak({ departmentId: "math", participantIds: ["science", "math", "research"], turns }).allowed).toBe(false);
    expect(maySpeak({ departmentId: "research", participantIds: ["science", "math", "research"], turns }).allowed).toBe(true);
  });

  it("still lets the addressed department answer", () => {
    const turns = [
      { departmentId: "science", departmentSlug: "science", kind: "question", body: "Math, check the bound.", addressedDepartmentId: "math" },
    ];
    expect(maySpeak({ departmentId: "math", participantIds: ["science", "math"], turns })).toMatchObject({ allowed: true, reason: "directed" });
  });

  it("stops scheduling when the message budget is spent", () => {
    expect(
      selectSpeaker({
        participants: [science, math],
        turns: [],
        topic: "budget",
        remainingMessages: 0,
      }),
    ).toBeNull();
  });

  it("keeps older turns in a labeled summary and the recent turns verbatim", () => {
    const turns = Array.from({ length: 9 }, (_, index) => ({
      id: `message-${index}`,
      department: index % 2 === 0 ? "science" : "math",
      kind: "response",
      body: `turn-${index}-with-enough-text-to-spend-budget`,
    }));
    const context = buildDialogueContext(turns, 40);
    expect(context.summary).toContain("summary (not a verbatim transcript)");
    expect(context.summary).toContain("message message-0");
    expect(context.summary).toContain("turn-0-with-enough-text-to-spend-budget");
    expect(context.verbatim.some((turn) => turn.body.startsWith("turn-0"))).toBe(false);
    expect(context.verbatim.at(-1)?.id).toBe("message-8");
    expect(context.tokens).toBeLessThanOrEqual(40 + estimateTokens(turns[8]!.body));
  });

  it("keeps human priority, direct routing, and the administrator goal boundary", () => {
    const selected = chooseDispatch(
      [
        { id: "auto", objectiveId: "auto", departmentId: "math", status: "ready", dependsOn: [], objectiveCreatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", schedulingRank: 1 },
        { id: "human", objectiveId: "human", departmentId: "math", status: "ready", dependsOn: [], objectiveCreatedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z", schedulingRank: 0 },
      ],
      { globalInflight: 0, globalLimit: 1, perObjective: 2, perDepartment: 2, inflightByObjective: {}, inflightByDepartment: {} },
    );
    expect(selected).toEqual(["human"]);
    expect(routeObjective("Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer.").path).toBe("direct");
    expect(ROLE_PERMISSIONS.department_agent.has("objective:submit")).toBe(false);
    expect(ROLE_PERMISSIONS.ceo_agent.has("autonomy:manage")).toBe(false);
    expect(readFileSync("packages/database/src/client.ts", "utf8")).toMatch(/max:\s*3/);
  });
});
