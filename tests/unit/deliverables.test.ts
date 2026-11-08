import { describe, expect, it } from "vitest";
import {
  deriveDeliverables,
  evaluateConclusionGate,
  preferredSpeakerForDeliverables,
  reconcileDeliverables,
  type ConversationClaimRecord,
} from "@ai-colony/core";

function claim(partial: Partial<ConversationClaimRecord> & Pick<ConversationClaimRecord, "id" | "claimText" | "verificationStatus" | "normalizedExpression">): ConversationClaimRecord {
  return {
    conversationId: "c1",
    proposingDepartmentId: "math",
    supportingTurnId: "t1",
    provenance: "model_turn",
    verifierId: null,
    verificationMethod: null,
    idempotencyKey: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewedAt: null,
    revision: 1,
    ...partial,
  };
}

describe("C1.7.4 Phase C deliverables", () => {
  it("derives the spacecraft checklist deterministically", () => {
    const derived = deriveDeliverables(
      "Compare chemical and ion propellant mass for delta-v 3000 m/s with Isp tradeoff.",
      "Spacecraft propellant comparison",
    );
    expect(derived.parseStatus).toBe("derived");
    expect(derived.deliverables.map((item) => item.id)).toEqual([
      "chemical_propellant_mass",
      "ion_propellant_mass",
      "thrust_duration_tradeoff",
      "assumptions",
      "final_comparison",
    ]);
  });

  it("marks requirements unknown when the objective cannot be parsed", () => {
    const derived = deriveDeliverables("Discuss team morale.", "General chat");
    expect(derived.parseStatus).toBe("unknown");
    expect(derived.deliverables).toEqual([]);
  });

  it("reconciles verified masses near 1396/107 and refutes ion>chemical", () => {
    const derived = deriveDeliverables(
      "Compare chemical and ion propellant mass with Isp and delta-v.",
      "Spacecraft",
    );
    const claims = [
      claim({
        id: "chem",
        claimText: "chemical requires about 1396 kg",
        verificationStatus: "verified",
        normalizedExpression: "tsiolkovsky_mp;label=chemical;isp=350;claim=1396",
      }),
      claim({
        id: "ion",
        claimText: "ion needs about 107 kg",
        verificationStatus: "verified",
        normalizedExpression: "tsiolkovsky_mp;label=ion;isp=3000;claim=107",
      }),
      claim({
        id: "bad",
        claimText: "ion needs more propellant than chemical",
        verificationStatus: "refuted",
        normalizedExpression: "tsiolkovsky_cmp;rel=greater_than",
      }),
    ];
    const reconciled = reconcileDeliverables({
      deliverables: derived.deliverables,
      claims,
      recentBodies: [
        "Assume dry mass 1000 kg, delta-v 3000 m/s, chemical Isp 350 s, ion Isp 3000 s. Thrust vs duration tradeoff favors ion for long burns.",
      ],
    });
    expect(reconciled.deliverables.find((item) => item.id === "chemical_propellant_mass")?.status).toBe("verified");
    expect(reconciled.deliverables.find((item) => item.id === "chemical_propellant_mass")?.verifiedValue).toBe(1396);
    expect(reconciled.deliverables.find((item) => item.id === "ion_propellant_mass")?.verifiedValue).toBe(107);
    expect(reconciled.deliverables.find((item) => item.id === "final_comparison")?.status).toBe("verified");
    expect(reconciled.deliverables.find((item) => item.id === "assumptions")?.provenance).toBe("stated_in_transcript");
    expect(reconciled.deliverables.find((item) => item.id === "thrust_duration_tradeoff")?.provenance).toContain("mentioned_in_transcript");
  });

  it("prefers Math when a numerical deliverable is missing", () => {
    const derived = deriveDeliverables(
      "Compare chemical and ion propellant mass with Isp.",
      "Spacecraft",
    );
    const preference = preferredSpeakerForDeliverables(derived.deliverables);
    expect(preference?.slug).toBe("math");
    expect(preference?.deliverableId).toBe("chemical_propellant_mass");
  });

  it("rejects premature success and requires verified values in the conclusion", () => {
    const derived = deriveDeliverables(
      "Compare chemical and ion propellant mass with Isp and delta-v.",
      "Spacecraft",
    );
    const openGate = evaluateConclusionGate({
      parseStatus: derived.parseStatus,
      deliverables: derived.deliverables,
      conclusionBody: "Ion is better overall.",
    });
    expect(openGate.ok).toBe(false);
    if (!openGate.ok) {
      expect(openGate.reason).toContain("deliverables_incomplete");
    }

    const reconciled = reconcileDeliverables({
      deliverables: derived.deliverables,
      claims: [
        claim({
          id: "chem",
          claimText: "chemical 1396",
          verificationStatus: "verified",
          normalizedExpression: "tsiolkovsky_mp;label=chemical;isp=350;claim=1396",
        }),
        claim({
          id: "ion",
          claimText: "ion 107",
          verificationStatus: "verified",
          normalizedExpression: "tsiolkovsky_mp;label=ion;isp=3000;claim=107",
        }),
      ],
      recentBodies: [
        "dry mass 1000 kg delta-v 3000 m/s Isp values stated; thrust/duration tradeoff noted as ion low thrust longer duration.",
      ],
    });
    const omitting = evaluateConclusionGate({
      parseStatus: "derived",
      deliverables: reconciled.deliverables,
      conclusionBody: "Ion uses less propellant than chemical.",
    });
    expect(omitting.ok).toBe(false);
    if (!omitting.ok) {
      expect(omitting.reason).toMatch(/conclusion_omits_verified_value/);
    }
    const complete = evaluateConclusionGate({
      parseStatus: "derived",
      deliverables: reconciled.deliverables,
      conclusionBody: "Chemical needs about 1396 kg propellant; ion needs about 107 kg; ion uses less propellant. Thrust/duration remains a tradeoff.",
    });
    expect(complete).toEqual({ ok: true });
  });

  it("rejects adversarial conclusions that only reuse verified numbers", () => {
    const derived = deriveDeliverables(
      "Compare chemical and ion propellant mass with Isp and delta-v.",
      "Spacecraft",
    );
    const reconciled = reconcileDeliverables({
      deliverables: derived.deliverables,
      claims: [
        claim({
          id: "chem",
          claimText: "chemical 1396",
          verificationStatus: "verified",
          normalizedExpression: "tsiolkovsky_mp;label=chemical;isp=350;claim=1396",
        }),
        claim({
          id: "ion",
          claimText: "ion 107",
          verificationStatus: "verified",
          normalizedExpression: "tsiolkovsky_mp;label=ion;isp=3000;claim=107",
        }),
      ],
      recentBodies: [
        "dry mass 1000 kg delta-v 3000 m/s Isp stated; thrust/duration tradeoff: ion lower thrust longer duration.",
      ],
    });

    const swapped = evaluateConclusionGate({
      parseStatus: "derived",
      deliverables: reconciled.deliverables,
      conclusionBody:
        "Chemical needs about 107 kg propellant; ion needs about 1396 kg; ion still uses less somehow. Thrust/duration remains a tradeoff.",
    });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) {
      expect(swapped.reason).toMatch(/conclusion_swaps_verified_value/);
    }

    const wrongUnits = evaluateConclusionGate({
      parseStatus: "derived",
      deliverables: reconciled.deliverables,
      conclusionBody:
        "Chemical needs about 1396 g propellant; ion needs about 107 tons; ion uses less propellant. Thrust/duration remains a tradeoff.",
    });
    expect(wrongUnits.ok).toBe(false);
    if (!wrongUnits.ok) {
      expect(wrongUnits.reason).toMatch(/conclusion_incorrect_units/);
    }

    const bareNumbers = evaluateConclusionGate({
      parseStatus: "derived",
      deliverables: reconciled.deliverables,
      conclusionBody:
        "The verified figures 1396 and 107 appear in the transcript, so we are done. Thrust/duration remains a tradeoff.",
    });
    expect(bareNumbers.ok).toBe(false);
    if (!bareNumbers.ok) {
      expect(bareNumbers.reason).toMatch(/conclusion_omits_verified_value|conclusion_swaps_verified_value/);
    }

    const contradictory = evaluateConclusionGate({
      parseStatus: "derived",
      deliverables: reconciled.deliverables,
      conclusionBody:
        "Chemical needs about 1396 kg propellant; ion needs about 107 kg; ion needs more propellant than chemical. Thrust/duration remains a tradeoff.",
    });
    expect(contradictory.ok).toBe(false);
    if (!contradictory.ok) {
      expect(contradictory.reason).toMatch(/refuted ion>chemical/);
    }
  });
});
