import { describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import {
  Authorizer,
  ClaimVerificationService,
  DEFAULT_MESSAGING_POLICY,
  DialogueService,
  DomainError,
  MessagingService,
  STANDARD_GRAVITY_M_S2,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { createPersistence, seed } from "@ai-colony/database";
import { ADMIN_ID, auth, createTestApp } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";

const route: InferenceRoute = {
  memoryProfile: "shared",
  alias: "qwen3-8b",
  operationalAlias: null,
  temperature: 0,
  maxOutputTokens: 256,
  timeoutMs: 1000,
  rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
  globalConcurrency: 2,
  departmentConcurrency: 1,
};

const persistence = createPersistence(testDb(), async () => undefined);
let now = Date.parse("2026-06-08T00:00:00.000Z");

describe("C1.7.4 claim verification foundation", () => {
  it("persists spacecraft propellant claims, verifies chemical/ion masses, and refutes ion>chemical", async () => {
    await seed(testDb());
    const { dialogue, claims } = services();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), turnProvider(), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Spacecraft propulsion propellant comparison",
      kind: "question",
      instruction: "Compare chemical and ion propellant mass for the same delta-v.",
      idempotencyKey: "c174-open-0001",
    });
    const turnId = (await persistence.repos.autonomy.listTurns(opened.conversationId))[0]?.id ?? null;

    const chemicalClaim = await claims.recordClaim(admin(), {
      conversationId: opened.conversationId,
      proposingDepartmentId: MATH_DEPARTMENT,
      supportingTurnId: turnId,
      claimText: "Chemical Isp 350 s needs about 1396 kg propellant for 3000 m/s with 1000 kg dry mass.",
      provenance: "model_turn",
    });
    expect(chemicalClaim.verificationStatus).toBe("unverified");

    const chemical = await claims.verifyNumerical(admin(), chemicalClaim.id, {
      kind: "tsiolkovsky_propellant_mass",
      input: { dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 350 },
      claimedPropellantMassKg: 1396,
      tolerance: { relative: 0.03, absolute: 40 },
    });
    expect((chemical.verification.outputs as { g0_m_s2?: number }).g0_m_s2).toBe(STANDARD_GRAVITY_M_S2);
    expect((chemical.verification.outputs as { equation?: string }).equation).toContain("Isp * g0");
    expect(chemical.claim.verificationStatus).toBe("verified");
    expect(chemical.verification.verdict).toBe("verified");
    expect(chemical.verification.method).toBe("deterministic_calculation");
    expect(chemical.verification.computedValue).toBeCloseTo(1396, -1);

    const ionClaim = await claims.recordClaim(admin(), {
      conversationId: opened.conversationId,
      proposingDepartmentId: MATH_DEPARTMENT,
      claimText: "Ion Isp 3000 s needs about 107 kg propellant for the same burn.",
      provenance: "model_turn",
    });
    const ion = await claims.verifyNumerical(admin(), ionClaim.id, {
      kind: "tsiolkovsky_propellant_mass",
      input: { dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 3000 },
      claimedPropellantMassKg: 107,
      tolerance: { relative: 0.05, absolute: 10 },
    });
    expect(ion.claim.verificationStatus).toBe("verified");
    expect(ion.verification.computedValue).toBeCloseTo(107, -1);

    const falseClaim = await claims.recordClaim(admin(), {
      conversationId: opened.conversationId,
      proposingDepartmentId: SCIENCE_DEPARTMENT,
      claimText: "Ion propulsion needs more propellant than chemical for this burn.",
      provenance: "model_turn",
    });
    const refuted = await claims.verifyNumerical(admin(), falseClaim.id, {
      kind: "tsiolkovsky_propellant_comparison",
      left: { label: "ion", dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 3000 },
      right: { label: "chemical", dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 350 },
      claimedRelation: "greater_than",
    });
    expect(refuted.claim.verificationStatus).toBe("refuted");
    expect(refuted.verification.verdict).toBe("refuted");
    expect(refuted.verification.diagnostic).toMatch(/greater_than/i);

    const listed = await claims.listClaims(admin(), opened.conversationId);
    expect(listed).toHaveLength(3);
    expect(listed.filter((row) => row.verificationStatus === "verified")).toHaveLength(2);
    expect(listed.some((row) => row.verificationStatus === "refuted")).toBe(true);

    const detail = await claims.getClaim(admin(), falseClaim.id);
    expect(detail.verifications).toHaveLength(1);
    expect(detail.verifications[0]?.inputs).toMatchObject({ claimedRelation: "greater_than" });
  });

  it("rejects LLM-agreement as a verification method and keeps wrong numbers unverified-as-fact", async () => {
    await seed(testDb());
    const { dialogue, claims } = services();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), turnProvider(), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Propellant claim review",
      kind: "question",
      instruction: "State a propellant mass.",
      idempotencyKey: "c174-open-0002",
    });
    const claim = await claims.recordClaim(admin(), {
      conversationId: opened.conversationId,
      proposingDepartmentId: MATH_DEPARTMENT,
      claimText: "Chemical propellant is 50 kg.",
      provenance: "model_turn",
    });
    await expect(
      claims.reviewClaim(admin(), claim.id, {
        decision: "verified",
        method: "another LLM agrees with Math",
      }),
    ).rejects.toBeInstanceOf(DomainError);

    const wrong = await claims.verifyNumerical(admin(), claim.id, {
      kind: "tsiolkovsky_propellant_mass",
      input: { dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 350 },
      claimedPropellantMassKg: 50,
      tolerance: { relative: 0.01, absolute: 5 },
    });
    expect(wrong.claim.verificationStatus).toBe("refuted");
    expect(wrong.claim.verificationStatus).not.toBe("verified");
  });

  it("exposes read-only claim and verification APIs with auth", async () => {
    await seed(testDb());
    const app = await createTestApp();
    const { dialogue, claims } = services();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), turnProvider(), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "API claim listing",
      kind: "question",
      instruction: "Open a conversation for claim reads.",
      idempotencyKey: "c174-open-0003",
    });
    const claim = await claims.recordClaim(admin(), {
      conversationId: opened.conversationId,
      proposingDepartmentId: MATH_DEPARTMENT,
      claimText: "Chemical propellant is about 1396 kg.",
      provenance: "system",
    });
    await claims.verifyNumerical(admin(), claim.id, {
      kind: "tsiolkovsky_propellant_mass",
      input: { dryMassKg: 1000, deltaV_m_s: 3000, isp_s: 350 },
      claimedPropellantMassKg: 1396,
      tolerance: { relative: 0.03, absolute: 40 },
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/department-conversations/${opened.conversationId}/claims`,
      headers: auth(ADMIN_ID),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().claims).toHaveLength(1);
    expect(list.json().claims[0].verificationStatus).toBe("verified");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/conversation-claims/${claim.id}`,
      headers: auth(ADMIN_ID),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().verifications).toHaveLength(1);
    expect(detail.json().verifications[0].method).toBe("deterministic_calculation");

    const verifications = await app.inject({
      method: "GET",
      url: `/api/v1/department-conversations/${opened.conversationId}/claim-verifications`,
      headers: auth(ADMIN_ID),
    });
    expect(verifications.statusCode).toBe(200);
    expect(verifications.json().verifications.length).toBeGreaterThanOrEqual(1);

    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/department-conversations/${opened.conversationId}/claims`,
    });
    expect(denied.statusCode).toBeGreaterThanOrEqual(400);

    await app.close();
  });
});

function services() {
  const authorizer = new Authorizer();
  const dialogue = new DialogueService(
    persistence,
    authorizer,
    new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY),
    () => new Date(now += 1000),
  );
  const claims = new ClaimVerificationService(persistence, authorizer, () => new Date(now += 1000));
  return { dialogue, claims };
}

function turnProvider(): InferenceProvider {
  return {
    async generate(request) {
      return observed(request, "Compare chemical and ion propellant requirements.");
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function observed(request: InferenceRequest, text: string): InferenceResult {
  return {
    text,
    servedModel: request.modelAlias,
    usage: { inputTokens: 8, outputTokens: 12, source: "observed" },
    latencyMs: 3,
  };
}

function admin(): RequestContext {
  return {
    correlationId: "c174",
    actor: {
      principalId: SYSTEM_ADMINISTRATOR_ID,
      principalType: "system",
      role: "system_administrator",
      agentId: null,
      departmentId: null,
      permissions: [],
    },
  };
}

function agent(id: string, departmentId: string): RequestContext {
  return {
    correlationId: "c174",
    actor: {
      principalId: id,
      principalType: "agent",
      role: "department_agent",
      agentId: id,
      departmentId,
      permissions: [],
    },
  };
}
