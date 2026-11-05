import { randomUUID } from "node:crypto";
import type { Actor } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";
import { Authorizer } from "../governance/authorizer.js";
import type { Permission } from "../governance/permissions.js";
import { EVALUATION_DEPARTMENT_ID, PRODUCT_AGENT_ID, PRODUCT_DEPARTMENT_ID } from "./identity.js";

export const IMPROVEMENT_STATUSES = [
  "proposed",
  "under_review",
  "approved",
  "in_progress",
  "evaluating",
  "completed",
  "rejected",
] as const;

export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number];
export type ImprovementRecommendation = "retain" | "revise" | "revert";
export type ImprovementPriority = "low" | "medium" | "high";

export const IMPROVEMENT_TRANSITIONS: Record<ImprovementStatus, readonly ImprovementStatus[]> = {
  proposed: ["under_review", "rejected"],
  under_review: ["approved", "rejected"],
  approved: ["in_progress"],
  in_progress: ["evaluating"],
  evaluating: ["completed"],
  completed: [],
  rejected: [],
};

const EXCLUDED_SLUGS = new Set(["product", "gaming", "engineering"]);
const NEW_DEPARTMENT = /\bnew department\b|\bmissing (?:a |an )?department\b/i;

const SOURCE_DEPARTMENTS: Record<ColonySignal["source"], readonly string[]> = {
  monitoring: ["monitoring"],
  evaluation: ["evaluation"],
  failure: ["monitoring", "reasoning"],
  collaboration: ["orchestration"],
  resource: ["monitoring"],
  capability: ["research"],
  experiment: ["evaluation"],
};

export interface ColonySignal {
  source: "monitoring" | "evaluation" | "failure" | "collaboration" | "resource" | "capability" | "experiment";
  summary: string;
  departmentSlug: string | null;
}

export interface ParticipantRecommendation {
  slug: string;
  reason: string;
}

export interface EvaluationEvidence {
  evaluatorDepartmentSlug: string;
  evaluatorAgentId: string;
  independent: true;
  passed: boolean;
  baseline: string;
  result: string;
  regression: boolean;
  resourceCost: string;
}

export interface ImprovementProposal {
  id: string;
  departmentId: string;
  proposedByAgentId: string;
  problem: string;
  evidence: ColonySignal[];
  expectedBenefit: string;
  participants: ParticipantRecommendation[];
  estimatedCost: string;
  risk: string;
  successCriteria: string;
  priority: ImprovementPriority;
  dependencies: string[];
  approvalRequirements: string[];
  recommendsNewDepartment: boolean;
  status: ImprovementStatus;
  evaluationEvidence: EvaluationEvidence | null;
  recommendation: ImprovementRecommendation | null;
  outcome: string | null;
  successful: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ImprovementEvent {
  id: string;
  proposalId: string;
  eventType: string;
  actorId: string;
  fromStatus: ImprovementStatus | null;
  toStatus: ImprovementStatus | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DispatchedWork {
  proposalId: string;
  departmentSlug: string;
  reason: string;
  objective: string;
}

export interface GovernedMemoryProposal {
  namespace: "department:product";
  provenance: "model_generated";
  isFact: false;
  requiresPromotion: true;
  departmentSlug: "memory-and-forgetting";
  statement: string;
  sourceProposalId: string;
}

export interface ImprovementStore {
  insert(proposal: ImprovementProposal): Promise<ImprovementProposal>;
  update(id: string, patch: Partial<ImprovementProposal>): Promise<ImprovementProposal>;
  find(id: string): Promise<ImprovementProposal | null>;
  appendEvent(event: ImprovementEvent): Promise<void>;
  listEvents(proposalId: string): Promise<ImprovementEvent[]>;
  list(): Promise<ImprovementProposal[]>;
}

export interface ProposalDraft {
  problem: string;
  signals: readonly ColonySignal[];
  activeSlugs: readonly string[];
  expectedBenefit: string;
  estimatedCost: string;
  risk: string;
  successCriteria: string;
  dependencies?: readonly string[];
}

export function recommendParticipants(
  signals: readonly ColonySignal[],
  activeSlugs: readonly string[],
): ParticipantRecommendation[] {
  const active = new Set(activeSlugs);
  const chosen = new Map<string, string>();
  const add = (slug: string, reason: string): void => {
    if (EXCLUDED_SLUGS.has(slug) || !active.has(slug) || chosen.has(slug)) {
      return;
    }
    chosen.set(slug, reason);
  };
  if (signals.length === 0) {
    add(
      "monitoring",
      "No evidence is attached. Monitoring should collect a baseline before any other department changes the colony.",
    );
    return [...chosen].map(([slug, reason]) => ({ slug, reason }));
  }
  for (const signal of signals) {
    if (signal.departmentSlug) {
      add(signal.departmentSlug, `The evidence names ${signal.departmentSlug}: ${signal.summary}`);
    }
    for (const slug of SOURCE_DEPARTMENTS[signal.source]) {
      add(slug, `${signal.source} evidence requires ${slug}: ${signal.summary}`);
    }
    const text = signal.summary.toLowerCase();
    if (/\bmath\b|\bmetric\b|\bp95\b|\bquantitative\b|\bregression\b/.test(text)) {
      add("math", `The evidence needs a quantitative check: ${signal.summary}`);
    }
    if (/\bhypothesis\b|\bexperiment design\b/.test(text)) {
      add("science", `The evidence describes a hypothesis: ${signal.summary}`);
    }
    if (/\bcontradict/.test(text)) {
      add("reasoning", `The evidence describes a contradiction: ${signal.summary}`);
    }
    if (/\bforgetting\b|\bretained memory\b|\bmemory namespace\b/.test(text)) {
      add("memory-and-forgetting", `The evidence concerns governed memory: ${signal.summary}`);
    }
    if (/\badapter\b|\bweights?\b|\btraining run\b/.test(text)) {
      add("weight-optimization", `The evidence concerns trained weights: ${signal.summary}`);
    }
    if (/\bliterature\b|\bsources?\b|\bresearch\b/.test(text)) {
      add("research", `The evidence asks for sources already available to Research: ${signal.summary}`);
    }
    if (NEW_DEPARTMENT.test(signal.summary)) {
      add(
        "evolution",
        "Evolution can recommend a new department. This recommendation does not create or activate one.",
      );
    }
  }
  if (chosen.size > 1) {
    add("orchestration", "More than one department is required, so Orchestration coordinates the approved work.");
  }
  return [...chosen].map(([slug, reason]) => ({ slug, reason }));
}

export function suggestPriority(signals: readonly ColonySignal[]): ImprovementPriority {
  if (signals.some((signal) => signal.source === "failure" || signal.source === "resource")) {
    return "high";
  }
  if (signals.some((signal) => signal.source === "evaluation" || signal.source === "experiment")) {
    return "medium";
  }
  return "low";
}

export function buildProposal(draft: ProposalDraft): Omit<
  ImprovementProposal,
  "id" | "departmentId" | "proposedByAgentId" | "status" | "evaluationEvidence" | "recommendation" | "outcome" | "successful" | "createdAt" | "updatedAt"
> {
  requireText("problem", draft.problem);
  requireText("expectedBenefit", draft.expectedBenefit);
  requireText("estimatedCost", draft.estimatedCost);
  requireText("risk", draft.risk);
  requireText("successCriteria", draft.successCriteria);
  if (!/\d/.test(draft.successCriteria)) {
    throw new DomainError("UNMEASURABLE_CRITERIA", "Success criteria must include a measurement", 422);
  }
  const participants = recommendParticipants(draft.signals, draft.activeSlugs);
  if (participants.length === 0) {
    throw new DomainError("NO_PARTICIPANTS", "The evidence did not select an active department", 422);
  }
  const recommendsNewDepartment = draft.signals.some((signal) => NEW_DEPARTMENT.test(signal.summary));
  const approvalRequirements = recommendsNewDepartment
    ? [
        "A system administrator must decide this proposal.",
        "CEO approval is not sufficient for a permanent-department recommendation.",
        "Approval does not create or activate a department.",
      ]
    : [
        "CEO may approve this ordinary improvement.",
        "A system administrator may also approve it.",
        "The Product agent cannot approve it.",
      ];
  return {
    problem: draft.problem.trim(),
    evidence: draft.signals.map((signal) => ({ ...signal })),
    expectedBenefit: draft.expectedBenefit.trim(),
    participants,
    estimatedCost: draft.estimatedCost.trim(),
    risk: draft.risk.trim(),
    successCriteria: draft.successCriteria.trim(),
    priority: suggestPriority(draft.signals),
    dependencies: [...(draft.dependencies ?? [])],
    approvalRequirements,
    recommendsNewDepartment,
  };
}

export function createMemoryImprovementStore(): ImprovementStore {
  const proposals = new Map<string, ImprovementProposal>();
  const events: ImprovementEvent[] = [];
  return {
    async insert(proposal) {
      proposals.set(proposal.id, proposal);
      return proposal;
    },
    async update(id, patch) {
      const current = proposals.get(id);
      if (!current) {
        throw new DomainError("NOT_FOUND", "Improvement proposal not found", 404);
      }
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      proposals.set(id, next);
      return next;
    },
    async find(id) {
      return proposals.get(id) ?? null;
    },
    async appendEvent(event) {
      events.push(event);
    },
    async listEvents(proposalId) {
      return events.filter((event) => event.proposalId === proposalId);
    },
    async list() {
      return [...proposals.values()];
    },
  };
}

export class ImprovementService {
  constructor(
    private readonly store: ImprovementStore,
    private readonly authorizer = new Authorizer(),
  ) {}

  async propose(actor: Actor, draft: ProposalDraft): Promise<ImprovementProposal> {
    this.assertProduct(actor);
    const body = buildProposal(draft);
    const now = new Date().toISOString();
    const proposal: ImprovementProposal = {
      ...body,
      id: randomUUID(),
      departmentId: PRODUCT_DEPARTMENT_ID,
      proposedByAgentId: PRODUCT_AGENT_ID,
      status: "proposed",
      evaluationEvidence: null,
      recommendation: null,
      outcome: null,
      successful: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insert(proposal);
    await this.event(actor, proposal.id, "improvement.proposed", null, "proposed", {
      participants: proposal.participants.map((participant) => participant.slug),
      recommendsNewDepartment: proposal.recommendsNewDepartment,
    });
    return proposal;
  }

  async submitForReview(actor: Actor, id: string): Promise<ImprovementProposal> {
    this.assertProduct(actor);
    return this.transition(actor, id, "under_review", "improvement.submitted");
  }

  async decide(
    actor: Actor,
    id: string,
    decision: "approved" | "rejected",
  ): Promise<{ proposal: ImprovementProposal; createdDepartment: false }> {
    if (this.isProductActor(actor)) {
      throw new DomainError("SELF_APPROVAL_FORBIDDEN", "Product cannot approve its own proposals", 403);
    }
    const current = await this.require(id);
    if (current.recommendsNewDepartment) {
      this.authorizer.assert(actor, "approval:decide:permanent");
    } else {
      this.authorizer.assert(actor, "approval:decide");
    }
    const proposal = await this.transition(actor, id, decision === "approved" ? "approved" : "rejected", "improvement.decided", {
      decision,
      createdDepartment: false,
    });
    return { proposal, createdDepartment: false };
  }

  async dispatch(actor: Actor, id: string): Promise<{ proposal: ImprovementProposal; work: DispatchedWork[] }> {
    if (actor.role !== "orchestration_agent" && actor.role !== "system_administrator") {
      throw new DomainError("AUTHORIZATION_DENIED", "Orchestration dispatches approved improvement work", 403);
    }
    const proposal = await this.transition(actor, id, "in_progress", "improvement.dispatched");
    return {
      proposal,
      work: proposal.participants
        .filter((participant) => participant.slug !== "product")
        .map((participant) => ({
          proposalId: proposal.id,
          departmentSlug: participant.slug,
          reason: participant.reason,
          objective: proposal.problem,
        })),
    };
  }

  async requestEvaluation(actor: Actor, id: string): Promise<ImprovementProposal> {
    if (!this.isProductActor(actor) && actor.role !== "orchestration_agent" && actor.role !== "system_administrator") {
      throw new DomainError("AUTHORIZATION_DENIED", "Product requests independent evaluation. It does not record the result.", 403);
    }
    return this.transition(actor, id, "evaluating", "improvement.evaluation_requested");
  }

  async recordEvaluation(actor: Actor, id: string, evidence: EvaluationEvidence): Promise<ImprovementProposal> {
    if (this.isProductActor(actor) || actor.agentId === PRODUCT_AGENT_ID) {
      throw new DomainError(
        "SELF_EVALUATION_FORBIDDEN",
        "Product cannot mark its own improvement successful",
        403,
      );
    }
    if (actor.departmentId !== EVALUATION_DEPARTMENT_ID || evidence.evaluatorDepartmentSlug !== "evaluation") {
      throw new DomainError("INDEPENDENT_EVALUATION_REQUIRED", "Evaluation must measure this improvement", 403);
    }
    if (evidence.independent !== true || !evidence.evaluatorAgentId || evidence.evaluatorAgentId === PRODUCT_AGENT_ID) {
      throw new DomainError("INDEPENDENT_EVALUATION_REQUIRED", "Evaluation evidence must come from the Evaluation agent", 422);
    }
    if (actor.agentId !== evidence.evaluatorAgentId) {
      throw new DomainError("INDEPENDENT_EVALUATION_REQUIRED", "The Evaluation agent must record its own measurement", 403);
    }
    requireText("baseline", evidence.baseline);
    requireText("result", evidence.result);
    requireText("resourceCost", evidence.resourceCost);
    const recommendation: ImprovementRecommendation = !evidence.passed
      ? "revert"
      : evidence.regression
        ? "revise"
        : "retain";
    const successful = evidence.passed && !evidence.regression;
    const current = await this.require(id);
    this.assertStatus(current.status, "completed");
    const outcome = `${evidence.result} compared with baseline ${evidence.baseline}; resource cost ${evidence.resourceCost}; recommendation ${recommendation}.`;
    const proposal = await this.store.update(id, {
      status: "completed",
      evaluationEvidence: evidence,
      recommendation,
      outcome,
      successful,
    });
    await this.event(actor, id, "improvement.evaluated", current.status, "completed", {
      recommendation,
      successful,
      regression: evidence.regression,
    });
    return proposal;
  }

  memoryProposal(proposal: ImprovementProposal): GovernedMemoryProposal {
    if (proposal.status !== "completed" || !proposal.evaluationEvidence || !proposal.recommendation) {
      throw new DomainError(
        "INDEPENDENT_EVALUATION_REQUIRED",
        "A memory can be proposed only after independent evaluation",
        409,
      );
    }
    return {
      namespace: "department:product",
      provenance: "model_generated",
      isFact: false,
      requiresPromotion: true,
      departmentSlug: "memory-and-forgetting",
      statement: `Improvement ${proposal.id} recommendation is ${proposal.recommendation}. ${proposal.outcome}`,
      sourceProposalId: proposal.id,
    };
  }

  assertCannotPerform(actor: Actor, permission: Permission): void {
    this.authorizer.assert(actor, permission);
  }

  private async transition(
    actor: Actor,
    id: string,
    to: ImprovementStatus,
    eventType: string,
    metadata: Record<string, unknown> = {},
  ): Promise<ImprovementProposal> {
    const current = await this.require(id);
    this.assertStatus(current.status, to);
    const proposal = await this.store.update(id, { status: to });
    await this.event(actor, id, eventType, current.status, to, metadata);
    return proposal;
  }

  private assertStatus(from: ImprovementStatus, to: ImprovementStatus): void {
    if (!IMPROVEMENT_TRANSITIONS[from].includes(to)) {
      throw new DomainError("INVALID_TRANSITION", `Cannot move an improvement from ${from} to ${to}`, 409, {
        from,
        to,
      });
    }
  }

  private async require(id: string): Promise<ImprovementProposal> {
    const proposal = await this.store.find(id);
    if (!proposal) {
      throw new DomainError("NOT_FOUND", "Improvement proposal not found", 404);
    }
    return proposal;
  }

  private assertProduct(actor: Actor): void {
    if (!this.isProductActor(actor)) {
      throw new DomainError("AUTHORIZATION_DENIED", "Only the Product agent can file this improvement proposal", 403);
    }
  }

  private isProductActor(actor: Actor): boolean {
    return actor.agentId === PRODUCT_AGENT_ID && actor.departmentId === PRODUCT_DEPARTMENT_ID;
  }

  private async event(
    actor: Actor,
    proposalId: string,
    eventType: string,
    fromStatus: ImprovementStatus | null,
    toStatus: ImprovementStatus | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendEvent({
      id: randomUUID(),
      proposalId,
      eventType,
      actorId: actor.principalId,
      fromStatus,
      toStatus,
      metadata,
      createdAt: new Date().toISOString(),
    });
  }
}

function requireText(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new DomainError("INVALID_PROPOSAL", `${field} is required`, 422, { field });
  }
}
