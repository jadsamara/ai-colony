import type { ClaimRelation, NumericalVerificationRequest } from "./numerical.js";

/**
 * Deterministic claim extraction from turn text.
 * Proposes structured candidates only — never verifies and never invents missing values.
 */

export interface ExtractedClaimCandidate {
  claimText: string;
  /** Stable fingerprint for idempotent persistence. */
  normalizedExpression: string;
  /** When null, the claim stays unverified/inconclusive. */
  verificationRequest: NumericalVerificationRequest | null;
  unsupportedReason: string | null;
  provenanceNote: string;
}

export interface QuantityBundle {
  dryMassKg: number | null;
  deltaV_m_s: number | null;
  chemicalIsp_s: number | null;
  ionIsp_s: number | null;
  genericIsp_s: number | null;
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;

function parseNumber(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function extractQuantities(text: string): QuantityBundle {
  const dryMassKg = firstMatch(text, [
    new RegExp(String.raw`dry\s*mass(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*kg`, "i"),
    new RegExp(String.raw`m_(?:dry|f)\s*=\s*${NUMBER}\s*kg`, "i"),
  ]);
  const deltaV_m_s = firstMatch(text, [
    new RegExp(String.raw`delta[\s\-]*v(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*m(?:eters)?\s*\/\s*s`, "i"),
    new RegExp(String.raw`Δv(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*m(?:eters)?\s*\/\s*s`, "i"),
  ]);
  const chemicalIsp_s = firstMatch(text, [
    new RegExp(String.raw`chemical(?:\s+propulsion)?(?:\s+isp|\s+I(?:sp|_sp))(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*s\b`, "i"),
    new RegExp(String.raw`Isp(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*s\b(?=[^.]{0,40}chemical)|chemical[^.]{0,40}Isp(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*s\b`, "i"),
  ]);
  const ionIsp_s = firstMatch(text, [
    new RegExp(String.raw`ion(?:\s+propulsion)?(?:\s+isp|\s+I(?:sp|_sp))(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*s\b`, "i"),
    new RegExp(String.raw`Isp(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*s\b(?=[^.]{0,40}ion)|ion[^.]{0,40}Isp(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*s\b`, "i"),
  ]);
  const genericIsp_s = firstMatch(text, [
    new RegExp(String.raw`(?:\bisp\b|\bI(?:sp|_sp)\b)(?:\s*(?:of|is|=|:))?\s*${NUMBER}\s*s\b`, "i"),
  ]);
  return { dryMassKg, deltaV_m_s, chemicalIsp_s, ionIsp_s, genericIsp_s };
}

function firstMatch(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }
    for (let index = 1; index < match.length; index += 1) {
      const value = parseNumber(match[index]);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

function mergeQuantities(primary: QuantityBundle, fallback: QuantityBundle): QuantityBundle {
  return {
    dryMassKg: primary.dryMassKg ?? fallback.dryMassKg,
    deltaV_m_s: primary.deltaV_m_s ?? fallback.deltaV_m_s,
    chemicalIsp_s: primary.chemicalIsp_s ?? fallback.chemicalIsp_s,
    ionIsp_s: primary.ionIsp_s ?? fallback.ionIsp_s,
    genericIsp_s: primary.genericIsp_s ?? fallback.genericIsp_s,
  };
}

function propellantMassClaims(text: string): Array<{ value: number; label: "chemical" | "ion" | "generic"; snippet: string }> {
  const rows: Array<{ value: number; label: "chemical" | "ion" | "generic"; snippet: string }> = [];
  const clauses = text.split(/(?:,|;|\band\b|\bwhile\b|\.|!|\?)/i).map((part) => part.trim()).filter(Boolean);
  const patterns: Array<{ label: "chemical" | "ion" | "generic"; re: RegExp }> = [
    {
      label: "chemical",
      re: new RegExp(
        String.raw`chemical(?:\s+Isp\s*${NUMBER}\s*s)?[^,]{0,60}?(?:requires?|needs?|uses?|propellant(?:\s+mass)?)\s*(?:about|approximately|≈|~|=|:)?\s*${NUMBER}\s*kg`,
        "i",
      ),
    },
    {
      label: "ion",
      re: new RegExp(
        String.raw`ion(?:\s+Isp\s*${NUMBER}\s*s)?[^,]{0,60}?(?:requires?|needs?|uses?|propellant(?:\s+mass)?)\s*(?:about|approximately|≈|~|=|:)?\s*${NUMBER}\s*kg`,
        "i",
      ),
    },
    {
      label: "generic",
      re: new RegExp(
        String.raw`propellant(?:\s+mass)?\s*(?:is|of|=|:)?\s*(?:about|approximately|≈|~)?\s*${NUMBER}\s*kg|${NUMBER}\s*kg(?:\s+of)?\s*propellant`,
        "i",
      ),
    },
  ];
  for (const clause of clauses) {
    for (const pattern of patterns) {
      const match = clause.match(pattern.re);
      if (!match) {
        continue;
      }
      // Prefer the last numeric capture (claimed mass); ignore Isp capture when present.
      const numericCaptures = match.slice(1).map(parseNumber).filter((value): value is number => value !== null);
      const value = numericCaptures.at(-1) ?? null;
      if (value === null) {
        continue;
      }
      const label =
        pattern.label !== "generic"
          ? pattern.label
          : /\bchemical\b/i.test(clause)
            ? "chemical"
            : /\bion\b/i.test(clause)
              ? "ion"
              : "generic";
      if (rows.some((row) => row.value === value && row.label === label)) {
        continue;
      }
      rows.push({ value, label, snippet: match[0].slice(0, 200) });
      break;
    }
  }
  return rows;
}

/**
 * Detect incorrect or incomplete m0 definitions without inventing numerical results.
 * Tsiolkovsky uses m0 = initial (wet) mass; defining m0 as dry/final mass is unsupported.
 */
function m0DefinitionClaims(text: string, turnId: string): ExtractedClaimCandidate[] {
  const out: ExtractedClaimCandidate[] = [];
  const asDryOrFinal =
    /\bm_?\s*0\b[^.…]{0,80}\b(?:dry|final)\b/i.test(text)
    || /\b(?:dry|final)\s+mass\b[^.…]{0,80}\bm_?\s*0\b/i.test(text)
    || /\bm_?\s*0\s*=\s*(?:m_?(?:dry|f)|dry\s*mass)/i.test(text);
  if (asDryOrFinal) {
    const match = text.match(/.{0,40}\bm_?\s*0\b.{0,60}/i);
    out.push({
      claimText: (match?.[0] ?? "m0 defined as dry/final mass").trim().slice(0, 200),
      normalizedExpression: "definition:m0_as_dry_or_final",
      verificationRequest: null,
      unsupportedReason:
        "m0 defined as dry or final mass; Tsiolkovsky m0 is initial (wet) mass — left unsupported without acceptance",
      provenanceNote: `turn:${turnId};deterministic_extraction;definition_check`,
    });
  } else if (/\bm_?\s*0\b/i.test(text) && propellantMassClaims(text).length === 0 && !comparisonClaim(text)) {
    const match = text.match(/.{0,40}\bm_?\s*0\b.{0,60}/i);
    out.push({
      claimText: (match?.[0] ?? "m0 mentioned").trim().slice(0, 200),
      normalizedExpression: "definition:m0_without_propellant_mass",
      verificationRequest: null,
      unsupportedReason:
        "m0 mentioned without an extractable numerical propellant-mass claim — left unsupported",
      provenanceNote: `turn:${turnId};deterministic_extraction;definition_check`,
    });
  }
  return out;
}

function comparisonClaim(text: string): { relation: ClaimRelation; snippet: string } | null {
  if (/ion(?:\s+propulsion)?[^.]{0,60}(?:requires?|needs?|uses?)\s+more\s+propellant[^.]{0,40}chemical/i.test(text)) {
    return { relation: "greater_than", snippet: "ion requires more propellant than chemical" };
  }
  if (/chemical[^.]{0,60}(?:requires?|needs?|uses?)\s+more\s+propellant[^.]{0,40}ion/i.test(text)) {
    return { relation: "less_than", snippet: "chemical requires more propellant than ion (claimed ion less)" };
  }
  if (/ion(?:\s+propulsion)?[^.]{0,60}(?:requires?|needs?|uses?)\s+less\s+propellant[^.]{0,40}chemical/i.test(text)) {
    return { relation: "less_than", snippet: "ion requires less propellant than chemical" };
  }
  return null;
}

export function extractNumericalClaims(input: {
  turnId: string;
  body: string;
  contextBodies?: readonly string[];
}): ExtractedClaimCandidate[] {
  const body = input.body.trim();
  if (!body) {
    return [];
  }
  const local = extractQuantities(body);
  const context = (input.contextBodies ?? []).map(extractQuantities).reduce<QuantityBundle>(
    (acc, row) => mergeQuantities(acc, row),
    { dryMassKg: null, deltaV_m_s: null, chemicalIsp_s: null, ionIsp_s: null, genericIsp_s: null },
  );
  const quantities = mergeQuantities(local, context);
  const usedContext =
    (local.dryMassKg === null && quantities.dryMassKg !== null)
    || (local.deltaV_m_s === null && quantities.deltaV_m_s !== null)
    || (local.chemicalIsp_s === null && quantities.chemicalIsp_s !== null)
    || (local.ionIsp_s === null && quantities.ionIsp_s !== null);
  const candidates: ExtractedClaimCandidate[] = [];

  const comparison = comparisonClaim(body);
  if (comparison) {
    const dryMassKg = quantities.dryMassKg;
    const deltaV_m_s = quantities.deltaV_m_s;
    const ionIsp = quantities.ionIsp_s;
    const chemicalIsp = quantities.chemicalIsp_s;
    const normalizedExpression = `tsiolkovsky_cmp:dry=${dryMassKg ?? "?"}:dv=${deltaV_m_s ?? "?"}:isp_ion=${ionIsp ?? "?"}:isp_chem=${chemicalIsp ?? "?"}:rel=${comparison.relation}`;
    if (dryMassKg === null || deltaV_m_s === null || ionIsp === null || chemicalIsp === null) {
      candidates.push({
        claimText: comparison.snippet,
        normalizedExpression,
        verificationRequest: null,
        unsupportedReason: "comparison is missing dry mass, delta-v, ion Isp, or chemical Isp",
        provenanceNote: `turn:${input.turnId};deterministic_extraction`,
      });
    } else {
      candidates.push({
        claimText: comparison.snippet,
        normalizedExpression,
        verificationRequest: {
          kind: "tsiolkovsky_propellant_comparison",
          left: { label: "ion", dryMassKg, deltaV_m_s, isp_s: ionIsp },
          right: { label: "chemical", dryMassKg, deltaV_m_s, isp_s: chemicalIsp },
          claimedRelation: comparison.relation,
        },
        unsupportedReason: null,
        provenanceNote: `turn:${input.turnId};deterministic_extraction${usedContext ? ";context_quantities" : ""}`,
      });
    }
  }

  for (const definition of m0DefinitionClaims(body, input.turnId)) {
    candidates.push(definition);
  }

  for (const mass of propellantMassClaims(body)) {
    const isp =
      mass.label === "chemical"
        ? quantities.chemicalIsp_s ?? quantities.genericIsp_s
        : mass.label === "ion"
          ? quantities.ionIsp_s ?? quantities.genericIsp_s
          : quantities.genericIsp_s ?? quantities.chemicalIsp_s ?? quantities.ionIsp_s;
    const dryMassKg = quantities.dryMassKg;
    const deltaV_m_s = quantities.deltaV_m_s;
    const label = mass.label === "generic" ? (quantities.chemicalIsp_s ? "chemical" : quantities.ionIsp_s ? "ion" : "generic") : mass.label;
    const normalizedExpression = `tsiolkovsky_mp:dry=${dryMassKg ?? "?"}:dv=${deltaV_m_s ?? "?"}:isp=${isp ?? "?"}:claim=${mass.value}:label=${label}`;
    if (dryMassKg === null || deltaV_m_s === null || isp === null) {
      candidates.push({
        claimText: mass.snippet,
        normalizedExpression,
        verificationRequest: null,
        unsupportedReason: "propellant mass claim is missing dry mass, delta-v, or Isp",
        provenanceNote: `turn:${input.turnId};deterministic_extraction`,
      });
      continue;
    }
    candidates.push({
      claimText: mass.snippet,
      normalizedExpression,
      verificationRequest: {
        kind: "tsiolkovsky_propellant_mass",
        input: { dryMassKg, deltaV_m_s, isp_s: isp },
        claimedPropellantMassKg: mass.value,
        tolerance: { relative: 0.03, absolute: Math.max(5, mass.value * 0.03) },
      },
      unsupportedReason: null,
      provenanceNote: `turn:${input.turnId};deterministic_extraction${usedContext ? ";context_quantities" : ""}`,
    });
  }

  return dedupe(candidates);
}

function dedupe(candidates: ExtractedClaimCandidate[]): ExtractedClaimCandidate[] {
  const seen = new Set<string>();
  const out: ExtractedClaimCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.normalizedExpression)) {
      continue;
    }
    seen.add(candidate.normalizedExpression);
    out.push(candidate);
  }
  return out;
}

export function claimIdempotencyKey(turnId: string, normalizedExpression: string): string {
  return `turn:${turnId}:expr:${normalizedExpression}`.slice(0, 240);
}

export function formatRefutedClaimNotice(input: {
  claimText: string;
  computedValue: number | null;
  claimedValue: number | null;
  turnId: string | null;
  diagnostic: string | null;
}): string {
  const parts = [
    "Independent verification result (not model-generated transcript content):",
    `Disputed statement: ${input.claimText}`,
    input.computedValue !== null ? `Independently calculated value: ${input.computedValue}` : null,
    input.claimedValue !== null ? `Claimed value: ${input.claimedValue}` : null,
    input.turnId ? `Source turn: ${input.turnId}` : null,
    input.diagnostic ? `Diagnostic: ${input.diagnostic}` : null,
    "Treat the disputed statement as challenged, not as an established fact.",
  ].filter(Boolean);
  return parts.join(" ");
}
