import { assessDeployment, promotionAllowed, retainedProvenance, verifyImprovement } from "@ai-colony/core";
import { describe, expect, it } from "vitest";

const valid = {
  sampleSize: 30,
  taskBaseline: 0,
  taskCandidate: 0,
  formatBaseline: 9 / 30,
  formatCandidate: 6 / 30,
  baselineOnly: 0,
  candidateOnly: 0,
  taskBaselineCorrect: 0,
  taskCandidateCorrect: 0,
  checksumsMatch: true,
  contaminated: false,
  familyCompatible: true,
  evaluationPresent: true,
  benchmarkValid: true,
  retentionPresent: true,
  retentionPassed: true,
};

describe("improvement verification", () => {
  it("keeps a safety-pass tie from becoming an improvement", () => {
    const verdict = verifyImprovement(valid);
    expect(verdict.classification).toBe("NO_VERIFIED_IMPROVEMENT");
    expect(assessDeployment({ classification: verdict.classification, safetyGate: "PASS", approved: true, compatible: true, revoked: false, contaminated: false, purpose: "improvement" }).eligibility).toBe("ineligible");
  });

  it("classifies a task drop, a format-only change, a short sample, and invalid evidence separately", () => {
    expect(verifyImprovement({ ...valid, taskBaseline: 0.4, taskCandidate: 0.1, taskBaselineCorrect: 12, taskCandidateCorrect: 3, baselineOnly: 9, candidateOnly: 0 }).classification).toBe("VERIFIED_REGRESSION");
    expect(verifyImprovement({ ...valid, formatCandidate: 1 }).classification).toBe("NO_VERIFIED_IMPROVEMENT");
    expect(verifyImprovement({ ...valid, sampleSize: 5, taskCandidate: 1, taskCandidateCorrect: 5, candidateOnly: 5 }).classification).toBe("INCONCLUSIVE");
    expect(verifyImprovement({ ...valid, contaminated: true }).classification).toBe("EVALUATION_INVALID");
    expect(verifyImprovement({ ...valid, benchmarkValid: false }).classification).toBe("EVALUATION_INVALID");
    expect(verifyImprovement({ ...valid, familyCompatible: false }).classification).toBe("EVALUATION_INVALID");
    expect(verifyImprovement({ ...valid, evaluationPresent: false }).classification).toBe("EVALUATION_INVALID");
    expect(verifyImprovement({ ...valid, taskCandidate: 0.5, taskCandidateCorrect: 15, candidateOnly: 15, retentionPresent: false }).classification).toBe("INCONCLUSIVE");
  });

  it("does not treat a one-item gain as verified and does verify a separated paired gain", () => {
    const oneItem = verifyImprovement({ ...valid, taskCandidate: 1 / 30, taskCandidateCorrect: 1, candidateOnly: 1 });
    expect(oneItem.classification).toBe("INCONCLUSIVE");
    const verified = verifyImprovement({
      ...valid,
      taskBaseline: 10 / 30,
      taskCandidate: 20 / 30,
      taskBaselineCorrect: 10,
      taskCandidateCorrect: 20,
      baselineOnly: 2,
      candidateOnly: 12,
    });
    expect(verified.classification).toBe("VERIFIED_IMPROVEMENT");
    expect(verified.claimSignificance).toBe(true);
    expect(verified.pValue).not.toBeNull();
    expect(assessDeployment({ classification: verified.classification, safetyGate: "PASS", approved: true, compatible: true, revoked: false, contaminated: false, purpose: "improvement" })).toEqual({ eligibility: "eligible", verifiedImprovement: true });
  });

  it("keeps an exceptional deployment from masquerading as improvement", () => {
    const decision = assessDeployment({ classification: "NO_VERIFIED_IMPROVEMENT", safetyGate: "PASS", approved: true, compatible: true, revoked: false, contaminated: false, purpose: "exceptional" });
    expect(decision).toEqual({ eligibility: "exceptional", verifiedImprovement: false });
    expect(assessDeployment({ classification: "VERIFIED_REGRESSION", safetyGate: "PASS", approved: true, compatible: true, revoked: false, contaminated: false, purpose: "exceptional" }).eligibility).toBe("ineligible");
    expect(assessDeployment({ classification: "VERIFIED_IMPROVEMENT", safetyGate: "PASS", approved: true, compatible: false, revoked: true, contaminated: false, purpose: "improvement" }).eligibility).toBe("ineligible");
  });
});

describe("memory promotion policy", () => {
  const base = {
    classification: "specialist" as const,
    kind: "contribution" as const,
    relevantToRecipientDomain: true,
    provenance: "user_provided" as const,
    validated: true,
    expired: false,
    forgotten: false,
    requesterPrivate: false,
    recipientAuthorized: true,
  };

  it("blocks consultation retention, private requests, forgotten content, and unverified model text", () => {
    expect(promotionAllowed({ ...base, classification: "consultation" }).allowed).toBe(false);
    expect(promotionAllowed({ ...base, kind: "request_context", requesterPrivate: true }).allowed).toBe(false);
    expect(promotionAllowed({ ...base, forgotten: true }).allowed).toBe(false);
    expect(promotionAllowed({ ...base, provenance: "model_generated" }).allowed).toBe(false);
    expect(promotionAllowed({ ...base, relevantToRecipientDomain: false }).allowed).toBe(false);
    expect(promotionAllowed(base).allowed).toBe(true);
    expect(retainedProvenance("user_provided")).toBe("user_provided");
    expect(retainedProvenance("externally_verified")).toBe("user_provided");
  });
});
