import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { objectivePerformanceSchema } from "@ai-colony/contracts";
import { buildPerformance, routeObjective } from "../../packages/core/src/objectives/efficiency.js";
import { planPrompt } from "../../packages/core/src/objectives/prompts.js";

const ARITHMETIC = "Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer.";
const SOLAR =
  "Compare solar and wind energy for powering a small remote research station. Calculate a simple illustrative energy requirement and identify important engineering tradeoffs.";

describe("complexity routing", () => {
  it("sends a closed arithmetic objective directly to math", () => {
    const route = routeObjective(ARITHMETIC);
    expect(route).toMatchObject({
      path: "direct",
      departments: ["math"],
      skipCeoPlanning: true,
      skipCeoSynthesis: true,
    });
    expect(route).not.toHaveProperty("confidence");
    expect(route.rationale.length).toBeGreaterThan(0);
  });

  it("sends a closed argument directly to reasoning", () => {
    const route = routeObjective(
      "Check this argument for a contradiction in the premise that one department is both idle and busy.",
    );
    expect(route).toMatchObject({
      path: "direct",
      departments: ["reasoning"],
      skipCeoPlanning: true,
      skipCeoSynthesis: true,
    });
  });

  it("uses lightweight coordination for two explicit capabilities", () => {
    const route = routeObjective("Calculate 12 times 4 and check whether the statement contains a contradiction.");
    expect(route).toMatchObject({
      path: "lightweight",
      departments: ["math", "reasoning"],
      skipCeoPlanning: true,
      skipCeoSynthesis: true,
    });
  });

  it("keeps comparison, ambiguity, and governed wording on full orchestration", () => {
    expect(routeObjective(SOLAR).path).toBe("full");
    expect(routeObjective("Stay inside a one-request budget.").path).toBe("full");
    expect(routeObjective("This plan will stay invalid.").path).toBe("full");
    expect(routeObjective("Cancel me before planning.").path).toBe("full");
    expect(routeObjective("Help me figure out what the colony should do next.").path).toBe("full");
    expect(routeObjective("Calculate the total.").path).toBe("full");
    expect(routeObjective("Approve a deployment and calculate 2 plus 2.").path).toBe("full");
    expect(routeObjective("Calculate 12 times 4 or check a contradiction.").path).toBe("full");
  });

  it("does not special-case the measured arithmetic example", () => {
    const source = readFileSync("packages/core/src/objectives/efficiency.ts", "utf8");
    expect(source).not.toMatch(/\b17\b/);
    expect(source).not.toMatch(/\b391\b/);
  });

  it("asks the CEO planner to add a department only when needed", () => {
    const prompt = planPrompt("Calculate 2 plus 2", [], { maxInferenceRequests: 12, maxOutputTokens: 8192 })
      .map((message) => message.content)
      .join("\n");
    expect(prompt).toMatch(/JSON object/);
    expect(prompt).toMatch(/only when the objective needs/);
    expect(prompt).not.toMatch(/Create one math task/);
  });

  it("keeps the shared postgres pool bounded", () => {
    const source = readFileSync("packages/database/src/client.ts", "utf8");
    expect(source).toMatch(/max:\s*3/);
  });

  it("keeps the efficiency migration additive", () => {
    const sql = readFileSync("packages/database/src/migrations/0014_efficiency.sql", "utf8");
    expect(sql).toMatch(/execution_path/);
    expect(sql).toMatch(/planning_completed_at/);
    expect(sql).toMatch(/synthesis_started_at/);
    for (const line of sql.split("\n")) {
      expect(line.trim().toLowerCase()).not.toMatch(/^(drop|delete|truncate|update)\b/);
    }
  });
});

describe("objective performance breakdown", () => {
  it("separates orchestration time from GPU inference time", () => {
    const performance = objectivePerformanceSchema.parse(
      buildPerformance({
        run: {
          id: "00000000-0000-4000-8000-000000000610",
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:01.000Z",
          planningCompletedAt: "2026-01-01T00:00:01.500Z",
          synthesisStartedAt: "2026-01-01T00:00:05.000Z",
          completedAt: "2026-01-01T00:00:05.200Z",
          executionPath: "direct",
          executionRationale: "The objective is a closed math request that one department can answer.",
        },
        tasks: [
          {
            id: "00000000-0000-4000-8000-000000000611",
            departmentSlug: "math",
            dependsOn: [],
            createdAt: "2026-01-01T00:00:02.000Z",
            startedAt: "2026-01-01T00:00:03.000Z",
            completedAt: "2026-01-01T00:00:04.000Z",
            requestMessageId: "00000000-0000-4000-8000-000000000613",
          },
        ],
        inferences: [
          {
            id: "00000000-0000-4000-8000-000000000612",
            taskId: "00000000-0000-4000-8000-000000000611",
            purpose: "specialist",
            status: "completed",
            createdAt: "2026-01-01T00:00:03.000Z",
            completedAt: "2026-01-01T00:00:03.040Z",
            inputTokens: 12,
            outputTokens: 24,
            tokenSource: "observed",
            latencyMs: 40,
          },
        ],
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000613",
            createdAt: "2026-01-01T00:00:02.000Z",
            publishedAt: "2026-01-01T00:00:02.100Z",
            deliveredAt: "2026-01-01T00:00:02.400Z",
          },
        ],
      }),
    );
    expect(performance.endToEndMs).toBe(5200);
    expect(performance.planningMs).toBe(500);
    expect(performance.planningGpuMs).toBeNull();
    expect(performance.synthesisMs).toBe(200);
    expect(performance.synthesisGpuMs).toBeNull();
    expect(performance.specialistGpuMs).toBe(40);
    expect(performance.inferenceRequestCount).toBe(1);
    expect(performance.tokenAccounting).toBe("observed");
    expect(performance.tasks[0]).toMatchObject({
      queueWaitMs: 1000,
      dependencyWaitMs: 0,
      executionMs: 1000,
      gpuInferenceMs: 40,
      messageDeliveryMs: 400,
    });
    expect(performance.tasks[0]?.queueWaitMs).not.toBe(performance.tasks[0]?.gpuInferenceMs);
    expect(performance.departments).toEqual([
      {
        departmentSlug: "math",
        taskCount: 1,
        inferenceRequestCount: 1,
        gpuInferenceMs: 40,
        executionMs: 1000,
      },
    ]);
  });
});
