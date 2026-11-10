import { describe, expect, it } from "vitest";
import {
  claimIdempotencyKey,
  extractNumericalClaims,
  formatRefutedClaimNotice,
  verifyNumericalClaim,
} from "@ai-colony/core";

describe("C1.7.4 Phase B claim extraction", () => {
  it("extracts and verifies chemical/ion propellant masses for the spacecraft case", () => {
    const body = [
      "With dry mass 1000 kg and delta-v 3000 m/s,",
      "chemical Isp 350 s requires about 1396 kg of propellant,",
      "while ion Isp 3000 s needs about 107 kg propellant.",
    ].join(" ");
    const extracted = extractNumericalClaims({ turnId: "turn-1", body });
    expect(extracted.length).toBeGreaterThanOrEqual(2);
    const chemical = extracted.find((row) => row.normalizedExpression.includes("isp=350") && row.normalizedExpression.includes("claim=1396"));
    const ion = extracted.find((row) => row.normalizedExpression.includes("isp=3000") && row.normalizedExpression.includes("claim=107"));
    expect(chemical?.verificationRequest?.kind).toBe("tsiolkovsky_propellant_mass");
    expect(ion?.verificationRequest?.kind).toBe("tsiolkovsky_propellant_mass");
    expect(verifyNumericalClaim(chemical!.verificationRequest!).verdict).toBe("verified");
    expect(verifyNumericalClaim(ion!.verificationRequest!).verdict).toBe("verified");
  });

  it("refutes the false ion-more-propellant comparison without inventing values", () => {
    const context = "Assume dry mass 1000 kg and delta-v 3000 m/s with chemical Isp 350 s and ion Isp 3000 s.";
    const body = "Ion propulsion needs more propellant than chemical for this burn.";
    const extracted = extractNumericalClaims({ turnId: "turn-2", body, contextBodies: [context] });
    const comparison = extracted.find((row) => row.normalizedExpression.includes("tsiolkovsky_cmp"));
    expect(comparison).toBeTruthy();
    expect(comparison?.verificationRequest?.kind).toBe("tsiolkovsky_propellant_comparison");
    const result = verifyNumericalClaim(comparison!.verificationRequest!);
    expect(result.verdict).toBe("refuted");
    expect(formatRefutedClaimNotice({
      claimText: comparison!.claimText,
      computedValue: result.computedValue,
      claimedValue: result.claimedValue,
      turnId: "turn-2",
      diagnostic: result.diagnostic,
    })).toContain("Independent verification result");
  });

  it("leaves incomplete claims without verification requests", () => {
    const extracted = extractNumericalClaims({
      turnId: "turn-3",
      body: "The propellant mass is about 1396 kg.",
    });
    expect(extracted.some((row) => row.verificationRequest === null)).toBe(true);
    expect(extracted.every((row) => row.unsupportedReason !== null || row.verificationRequest !== null)).toBe(true);
  });

  it("builds stable idempotency keys", () => {
    expect(claimIdempotencyKey("t1", "expr-a")).toBe("turn:t1:expr:expr-a");
  });

  it("flags incorrect m0=dry definitions as unsupported without inventing propellant masses", () => {
    const extracted = extractNumericalClaims({
      turnId: "turn-m0",
      body: "Let m0 = 1000 kg dry mass and apply the rocket equation with Isp 350 s.",
    });
    expect(extracted.some((row) => row.normalizedExpression === "definition:m0_as_dry_or_final")).toBe(true);
    expect(extracted.every((row) => row.verificationRequest === null)).toBe(true);
    expect(extracted.every((row) => row.unsupportedReason !== null)).toBe(true);
  });

  it("records m0 mentions without propellant-mass numbers as unsupported, not verified", () => {
    const extracted = extractNumericalClaims({
      turnId: "turn-m0b",
      body: "Define m0 carefully before rearranging the Tsiolkovsky equation for propellant.",
    });
    expect(extracted.some((row) => row.normalizedExpression === "definition:m0_without_propellant_mass")).toBe(true);
    expect(extracted.every((row) => row.verificationRequest === null)).toBe(true);
  });
});
