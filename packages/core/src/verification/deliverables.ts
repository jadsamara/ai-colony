import type { ConversationClaimRecord } from "./claim-repository.js";

export type DeliverableKind = "numerical" | "qualitative" | "comparison" | "assumptions";
export type DeliverableStatus = "open" | "verified" | "refuted" | "blocked" | "unknown";
export type DeliverableParseStatus = "pending" | "derived" | "unknown";
export type PreferredDepartmentSlug = "math" | "science" | "reasoning";

export interface ConversationDeliverable {
  id: string;
  label: string;
  kind: DeliverableKind;
  required: boolean;
  status: DeliverableStatus;
  preferredDepartmentSlug: PreferredDepartmentSlug | null;
  matchHints: string[];
  claimId: string | null;
  turnId: string | null;
  verifiedValue: number | null;
  provenance: string;
}

export interface DeliverableDerivation {
  parseStatus: DeliverableParseStatus;
  deliverables: ConversationDeliverable[];
}

function base(
  partial: Omit<ConversationDeliverable, "status" | "claimId" | "turnId" | "verifiedValue" | "provenance"> & {
    provenance?: string;
  },
): ConversationDeliverable {
  return {
    ...partial,
    status: "open",
    claimId: null,
    turnId: null,
    verifiedValue: null,
    provenance: partial.provenance ?? "deterministic_instruction_parse",
  };
}

/**
 * Deterministic deliverable checklist from the original instruction/topic.
 * Unsupported task shapes return parseStatus "unknown" without inventing requirements.
 */
export function deriveDeliverables(instruction: string, topic: string): DeliverableDerivation {
  const text = `${instruction}\n${topic}`.toLowerCase();
  const spacecraft =
    /\b(propellant|isp|delta[\s\-]*v|tsiolkovsky|rocket equation)\b/.test(text)
    && /\b(ion|chemical|compare|comparison|mass|tradeoff|trade-off)\b/.test(text);
  if (spacecraft) {
    return {
      parseStatus: "derived",
      deliverables: [
        base({
          id: "chemical_propellant_mass",
          label: "Chemical propellant mass",
          kind: "numerical",
          required: true,
          preferredDepartmentSlug: "math",
          matchHints: ["label=chemical", "isp=350", "tsiolkovsky_mp"],
        }),
        base({
          id: "ion_propellant_mass",
          label: "Ion propellant mass",
          kind: "numerical",
          required: true,
          preferredDepartmentSlug: "math",
          matchHints: ["label=ion", "isp=3000", "tsiolkovsky_mp"],
        }),
        base({
          id: "thrust_duration_tradeoff",
          label: "Thrust/duration tradeoff",
          kind: "qualitative",
          required: true,
          preferredDepartmentSlug: "science",
          matchHints: ["thrust", "duration", "tradeoff", "trade-off"],
        }),
        base({
          id: "assumptions",
          label: "Stated assumptions (dry mass, delta-v, Isp, g0)",
          kind: "assumptions",
          required: true,
          preferredDepartmentSlug: "science",
          matchHints: ["dry mass", "delta-v", "isp", "g0", "assumption"],
        }),
        base({
          id: "final_comparison",
          label: "Final propellant comparison",
          kind: "comparison",
          required: true,
          preferredDepartmentSlug: "reasoning",
          matchHints: ["tsiolkovsky_cmp", "comparison", "less propellant", "more propellant"],
        }),
      ],
    };
  }
  if (/\b(calculate|compute|derive)\b/.test(text) && /\b(mass|force|energy|delta[\s\-]*v|isp)\b/.test(text)) {
    return {
      parseStatus: "derived",
      deliverables: [
        base({
          id: "primary_calculation",
          label: "Primary numerical calculation",
          kind: "numerical",
          required: true,
          preferredDepartmentSlug: "math",
          matchHints: ["tsiolkovsky_mp", "claim="],
        }),
        base({
          id: "assumptions",
          label: "Stated calculation assumptions",
          kind: "assumptions",
          required: true,
          preferredDepartmentSlug: "science",
          matchHints: ["assumption", "dry mass", "delta-v"],
        }),
      ],
    };
  }
  return { parseStatus: "unknown", deliverables: [] };
}

function claimMatches(claim: ConversationClaimRecord, hints: string[]): boolean {
  const haystack = `${claim.normalizedExpression ?? ""} ${claim.claimText}`.toLowerCase();
  // Prefer label/Isp discriminators so shared calc tags (e.g. tsiolkovsky_mp) do not cross-bind.
  const discriminators = hints.filter((hint) => hint.startsWith("label=") || hint.startsWith("isp="));
  if (discriminators.length > 0) {
    return discriminators.some((hint) => haystack.includes(hint.toLowerCase()));
  }
  return hints.some((hint) => haystack.includes(hint.toLowerCase()));
}

export function reconcileDeliverables(input: {
  deliverables: readonly ConversationDeliverable[];
  claims: readonly ConversationClaimRecord[];
  recentBodies?: readonly string[];
}): { deliverables: ConversationDeliverable[]; pendingCorrections: string[] } {
  const pendingCorrections: string[] = [];
  const deliverables = input.deliverables.map((item) => ({ ...item }));
  for (const deliverable of deliverables) {
    if (deliverable.kind === "numerical") {
      const matches = input.claims.filter((claim) => claimMatches(claim, deliverable.matchHints));
      const verified = matches.find((claim) => claim.verificationStatus === "verified");
      const refuted = matches.find((claim) => claim.verificationStatus === "refuted");
      if (verified) {
        deliverable.status = "verified";
        deliverable.claimId = verified.id;
        deliverable.turnId = verified.supportingTurnId;
        deliverable.provenance = `verified_claim:${verified.id}`;
        // Prefer computed value from normalized expression claim=N when present.
        const claimed = verified.normalizedExpression?.match(/claim=(\d+(?:\.\d+)?)/);
        deliverable.verifiedValue = claimed ? Number(claimed[1]) : deliverable.verifiedValue;
        continue;
      }
      if (refuted) {
        deliverable.status = "refuted";
        deliverable.claimId = refuted.id;
        deliverable.turnId = refuted.supportingTurnId;
        deliverable.provenance = `refuted_claim:${refuted.id}`;
        pendingCorrections.push(
          `Correct deliverable "${deliverable.label}": prior claim was independently refuted (claim ${refuted.id}). Provide a calculator-backed value.`,
        );
        continue;
      }
      deliverable.status = "open";
      continue;
    }

    if (deliverable.kind === "comparison") {
      const matches = input.claims.filter((claim) => claimMatches(claim, deliverable.matchHints));
      const falseGreater = matches.find(
        (claim) =>
          claim.verificationStatus === "refuted"
          && /rel=greater_than|more propellant/i.test(`${claim.normalizedExpression ?? ""} ${claim.claimText}`),
      );
      const trueLess = matches.find(
        (claim) =>
          claim.verificationStatus === "verified"
          && /rel=less_than|less propellant/i.test(`${claim.normalizedExpression ?? ""} ${claim.claimText}`),
      );
      if (trueLess) {
        deliverable.status = "verified";
        deliverable.claimId = trueLess.id;
        deliverable.turnId = trueLess.supportingTurnId;
        deliverable.provenance = `verified_claim:${trueLess.id}`;
        continue;
      }
      // Verified masses independently settle the comparison even if a prior false claim was refuted.
      const chemical = input.claims.find(
        (claim) => claim.verificationStatus === "verified" && /label=chemical|isp=350/.test(claim.normalizedExpression ?? ""),
      );
      const ion = input.claims.find(
        (claim) => claim.verificationStatus === "verified" && /label=ion|isp=3000/.test(claim.normalizedExpression ?? ""),
      );
      if (chemical && ion) {
        deliverable.status = "verified";
        deliverable.claimId = ion.id;
        deliverable.turnId = ion.supportingTurnId;
        deliverable.provenance = `derived_from_verified_masses:${chemical.id},${ion.id}`;
        continue;
      }
      if (falseGreater) {
        deliverable.status = "refuted";
        deliverable.claimId = falseGreater.id;
        deliverable.turnId = falseGreater.supportingTurnId;
        deliverable.provenance = `refuted_claim:${falseGreater.id}`;
        pendingCorrections.push(
          `Correct deliverable "${deliverable.label}": the claim that ion requires more propellant than chemical was independently refuted.`,
        );
        continue;
      }
      deliverable.status = "open";
      continue;
    }

    if (deliverable.kind === "assumptions") {
      const bodies = input.recentBodies ?? [];
      const stated = bodies.some((body) =>
        /dry\s*mass/i.test(body) && /delta[\s\-]*v/i.test(body) && /\bisp\b/i.test(body),
      );
      // Stated assumptions are tracked but not calculator-verified facts.
      deliverable.status = stated ? "open" : "open";
      deliverable.provenance = stated ? "stated_in_transcript" : "deterministic_instruction_parse";
      continue;
    }

    if (deliverable.kind === "qualitative") {
      const bodies = input.recentBodies ?? [];
      const stated = bodies.some((body) =>
        deliverable.matchHints.some((hint) => new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(body)),
      );
      deliverable.status = "open";
      deliverable.provenance = stated ? "mentioned_in_transcript_unverified" : "deterministic_instruction_parse";
    }
  }
  return { deliverables, pendingCorrections };
}

function deliverableNeedsAttention(deliverable: ConversationDeliverable): boolean {
  if (!deliverable.required || !deliverable.preferredDepartmentSlug) {
    return false;
  }
  if (deliverable.status === "refuted" || deliverable.status === "blocked") {
    return true;
  }
  if (deliverable.kind === "qualitative") {
    return !deliverable.provenance.startsWith("mentioned_in_transcript");
  }
  if (deliverable.kind === "assumptions") {
    return deliverable.provenance !== "stated_in_transcript";
  }
  return deliverable.status === "open" || deliverable.status === "unknown";
}

export function preferredSpeakerForDeliverables(
  deliverables: readonly ConversationDeliverable[],
): { slug: PreferredDepartmentSlug; deliverableId: string; reason: string } | null {
  const priority: DeliverableStatus[] = ["refuted", "blocked", "open", "unknown"];
  for (const status of priority) {
    const item = deliverables.find(
      (deliverable) => deliverable.status === status && deliverableNeedsAttention(deliverable),
    );
    if (item?.preferredDepartmentSlug) {
      return {
        slug: item.preferredDepartmentSlug,
        deliverableId: item.id,
        reason: `deliverable:${item.id}:${item.status}`,
      };
    }
  }
  return null;
}

function attributionLabels(item: ConversationDeliverable): string[] {
  const fromHints = item.matchHints
    .filter((hint) => hint.startsWith("label="))
    .map((hint) => hint.slice("label=".length).trim())
    .filter(Boolean);
  if (fromHints.length > 0) {
    return fromHints;
  }
  if (/chemical/i.test(item.id) || /chemical/i.test(item.label)) {
    return ["chemical"];
  }
  if (/\bion\b/i.test(item.id) || /\bion\b/i.test(item.label)) {
    return ["ion"];
  }
  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function valueForms(value: number): string[] {
  const rounded = String(Math.round(value));
  const exact = String(value);
  return rounded === exact ? [rounded] : [rounded, exact];
}

function conclusionClauses(body: string): string[] {
  return body
    .split(/[.;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function clauseHasValue(clause: string, value: number): boolean {
  return valueForms(value).some((form) => {
    const pattern = new RegExp(`(?:^|[^0-9.])${escapeRegExp(form)}(?:[^0-9.]|$)`);
    return pattern.test(clause);
  });
}

function clauseHasLabel(clause: string, labels: readonly string[]): boolean {
  return labels.some((label) => new RegExp(`\\b${escapeRegExp(label)}\\b`, "i").test(clause));
}

/** True when a verified value is attributed to this deliverable's label in the same clause. */
export function conclusionAttributesValue(
  body: string,
  item: ConversationDeliverable,
  value: number,
): boolean {
  const labels = attributionLabels(item);
  return conclusionClauses(body).some((clause) => {
    if (!clauseHasValue(clause, value)) {
      return false;
    }
    if (labels.length === 0) {
      return true;
    }
    return clauseHasLabel(clause, labels);
  });
}

function conclusionUsesMassUnits(body: string, item: ConversationDeliverable, value: number): boolean {
  const labels = attributionLabels(item);
  const unit = String.raw`(?:kg|kilograms?)`;
  return conclusionClauses(body).some((clause) => {
    if (!clauseHasValue(clause, value)) {
      return false;
    }
    if (labels.length > 0 && !clauseHasLabel(clause, labels)) {
      return false;
    }
    return valueForms(value).some((form) =>
      new RegExp(`${escapeRegExp(form)}\\s*${unit}\\b`, "i").test(clause),
    );
  });
}

function isMassDeliverable(item: ConversationDeliverable): boolean {
  return /mass/i.test(item.id) || /mass/i.test(item.label) || /propellant/i.test(item.label);
}

export function evaluateConclusionGate(input: {
  parseStatus: DeliverableParseStatus;
  deliverables: readonly ConversationDeliverable[];
  conclusionBody: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.parseStatus !== "derived") {
    // Unknown requirements: do not invent a gate, but reject known-false spacecraft comparison language.
    if (/ion.{0,60}more\s+propellant.{0,40}chemical/i.test(input.conclusionBody)) {
      return { ok: false, reason: "conclusion repeats a refuted ion>chemical comparison" };
    }
    return { ok: true };
  }
  const required = input.deliverables.filter((item) => item.required);
  const incomplete = required.filter((item) => {
    if (item.kind === "qualitative") {
      // Must be mentioned and explicitly qualified; never treated as calculator-verified.
      return !item.provenance.startsWith("mentioned_in_transcript");
    }
    if (item.kind === "assumptions") {
      return item.provenance !== "stated_in_transcript";
    }
    return item.status !== "verified";
  });
  if (incomplete.length > 0) {
    return {
      ok: false,
      reason: `deliverables_incomplete: ${incomplete.map((item) => item.id).join(",")}`,
    };
  }
  const numerical = required.filter(
    (item): item is ConversationDeliverable & { verifiedValue: number } =>
      item.kind === "numerical" && item.verifiedValue !== null,
  );
  for (const item of numerical) {
    if (!conclusionAttributesValue(input.conclusionBody, item, item.verifiedValue)) {
      const swappedWith = numerical.find(
        (other) =>
          other.id !== item.id
          && conclusionAttributesValue(input.conclusionBody, item, other.verifiedValue),
      );
      if (swappedWith) {
        return { ok: false, reason: `conclusion_swaps_verified_value:${item.id}` };
      }
      return { ok: false, reason: `conclusion_omits_verified_value:${item.id}` };
    }
    if (isMassDeliverable(item) && !conclusionUsesMassUnits(input.conclusionBody, item, item.verifiedValue)) {
      return { ok: false, reason: `conclusion_incorrect_units:${item.id}` };
    }
  }
  if (/ion.{0,60}more\s+propellant.{0,40}chemical/i.test(input.conclusionBody)) {
    return { ok: false, reason: "conclusion repeats a refuted ion>chemical comparison" };
  }
  return { ok: true };
}

export function renderDeliverableChecklist(deliverables: readonly ConversationDeliverable[], parseStatus: DeliverableParseStatus): string | null {
  if (parseStatus === "pending") {
    return null;
  }
  if (parseStatus === "unknown") {
    return "Deliverable checklist: unknown (instruction could not be reliably parsed; do not invent requirements).";
  }
  if (deliverables.length === 0) {
    return null;
  }
  const lines = deliverables.map(
    (item) =>
      `- ${item.id} [${item.status}/${item.kind}] ${item.label}`
      + (item.verifiedValue !== null ? ` verified_value=${item.verifiedValue}` : "")
      + (item.claimId ? ` claim=${item.claimId}` : ""),
  );
  return ["Deliverable checklist (independent tracking, not model-generated facts):", ...lines].join("\n");
}
