import { randomUUID } from "node:crypto";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { MessagingService } from "../messaging/message-service.js";
import type { Persistence } from "../ports/repositories.js";
import { promotionAllowed, retainedProvenance, type CollaborationClass } from "./collaboration-policy.js";
import type { CollaborationContextRecord, CollaborationEntryRecord } from "./repository.js";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class CollaborationService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly memories: MemoryService,
    private readonly messages: MessagingService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async openConsultation(ctx: RequestContext, input: { recipientDepartmentId: string; question: string; idempotencyKey: string; ttlMs?: number }) {
    return this.open(ctx, { ...input, classification: "consultation", recipientStatus: "active" });
  }

  async openSpecialist(ctx: RequestContext, input: { recipientDepartmentId: string; question: string; idempotencyKey: string; ttlMs?: number }) {
    return this.open(ctx, { ...input, classification: "specialist", recipientStatus: "invited" });
  }

  async openJoint(ctx: RequestContext, input: { recipientDepartmentId: string; purpose: string; idempotencyKey: string }) {
    return this.open(ctx, { recipientDepartmentId: input.recipientDepartmentId, question: input.purpose, idempotencyKey: input.idempotencyKey, classification: "joint", recipientStatus: "invited", ttlMs: null });
  }

  async accept(ctx: RequestContext, contextId: string) {
    this.authorizer.assert(ctx.actor, "learning:propose");
    const context = await this.requireContext(contextId);
    if (context.status !== "open") {
      throw new DomainError("INVALID_STATE", "The collaboration is closed", 409);
    }
    const participants = await this.persistence.repos.learning.listParticipants(contextId);
    const mine = participants.find((row) => row.departmentId === ctx.actor.departmentId && row.status === "invited");
    if (!mine) {
      throw new DomainError("AUTHORIZATION_DENIED", "Only an invited department can join this collaboration", 403);
    }
    await this.persistence.repos.learning.updateParticipant(mine.id, "active");
    await this.audit(ctx, "collaboration.accepted", contextId, { classification: context.classification });
    return { contextId, status: "active" as const };
  }

  async contribute(ctx: RequestContext, contextId: string, input: { content: string; kind: "answer" | "contribution" | "shared_decision"; provenance: CollaborationEntryRecord["provenance"]; idempotencyKey: string; relevantToRecipientDomain: boolean }) {
    this.authorizer.assert(ctx.actor, "learning:propose");
    const context = await this.requireOpen(contextId);
    await this.requireActive(ctx, context);
    const existing = await this.persistence.repos.learning.findEntryByKey(input.idempotencyKey);
    if (existing) {
      return this.redact(existing, context);
    }
    if (context.classification === "joint" && !(await this.bothActive(contextId))) {
      throw new DomainError("INVALID_STATE", "A joint task stores shared memory only after every invited department accepts", 409);
    }
    const row: CollaborationEntryRecord = {
      id: randomUUID(),
      contextId,
      authorDepartmentId: ctx.actor.departmentId ?? context.ownerDepartmentId,
      kind: input.kind,
      content: input.content,
      provenance: input.provenance,
      status: "active",
      expiresAt: context.classification === "joint" ? null : context.expiresAt,
      promotedMemoryId: null,
      sourceMemoryId: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.repos.learning.insertEntry(row);
    if (ctx.actor.agentId && ctx.actor.departmentId) {
      await this.messages.send(ctx, {
        messageType: "TASK_RESULT",
        recipientDepartmentId: context.ownerDepartmentId === ctx.actor.departmentId ? await this.otherDepartment(contextId, ctx.actor.departmentId) : context.ownerDepartmentId,
        priority: 5,
        idempotencyKey: `collab.result.${row.id}`,
        payload: { taskId: contextId, status: "recorded", summary: input.content.slice(0, 4000), artifactReferences: [] },
      });
    }
    return this.redact(row, context);
  }

  async retainAnswer(ctx: RequestContext, entryId: string) {
    this.authorizer.assert(ctx.actor, "memory:create");
    const entry = await this.requireEntry(entryId);
    const context = await this.requireContext(entry.contextId);
    if (ctx.actor.departmentId !== context.ownerDepartmentId && ctx.actor.role !== "system_administrator") {
      throw new DomainError("AUTHORIZATION_DENIED", "Only the requesting department retains the answer", 403);
    }
    if (entry.kind !== "answer" || entry.status !== "active") {
      throw new DomainError("INVALID_STATE", "Only an active answer can be retained", 409);
    }
    const memory = await this.memories.createMemory(ctx, {
      scope: "department",
      category: "semantic",
      departmentId: context.ownerDepartmentId,
      title: `answer from ${entry.authorDepartmentId}`,
      summary: entry.content.slice(0, 500),
      content: entry.content,
      provenance: retainedProvenance(entry.provenance),
      idempotencyKey: `retained-${entry.id}`,
    });
    await this.persistence.repos.learning.insertOwnership({
      memoryId: memory.id,
      originatingDepartmentId: entry.authorDepartmentId,
      primaryOwnerDepartmentId: context.ownerDepartmentId,
      recipientDepartmentId: null,
      classification: "consultation",
      collaborationId: context.id,
      retentionPolicy: "requester-owned answer",
      promotionReason: "The requester retained the answer. The recipient did not.",
      validationStatus: "unverified",
      sourceMessageId: null,
      createdAt: this.now().toISOString(),
    });
    return { memoryId: memory.id, provenance: memory.provenance };
  }

  async promote(ctx: RequestContext, entryId: string, relevantToRecipientDomain: boolean) {
    this.authorizer.assert(ctx.actor, "memory:promote:propose");
    const entry = await this.requireEntry(entryId);
    const context = await this.requireContext(entry.contextId);
    await this.requireActive(ctx, context);
    if (!ctx.actor.departmentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Promotion requires a department", 403);
    }
    const source = entry.sourceMemoryId ? await this.persistence.repos.memories.findById(entry.sourceMemoryId) : null;
    const decision = promotionAllowed({
      classification: context.classification,
      kind: entry.kind,
      relevantToRecipientDomain,
      provenance: entry.provenance,
      validated: true,
      expired: this.expired(entry, context),
      forgotten: source?.status === "forgotten" || entry.status === "expired",
      requesterPrivate: entry.kind === "request_context" || entry.authorDepartmentId === context.ownerDepartmentId && context.classification !== "joint" && entry.kind !== "contribution",
      recipientAuthorized: true,
    });
    if (!decision.allowed) {
      throw new DomainError("PROMOTION_DENIED", decision.reason, 422);
    }
    const memory = await this.memories.createMemory(ctx, {
      scope: "department",
      category: "semantic",
      departmentId: ctx.actor.departmentId,
      title: `promoted ${entry.kind}`,
      summary: entry.content.slice(0, 500),
      content: entry.content,
      provenance: retainedProvenance(entry.provenance),
      idempotencyKey: `promoted-${entry.id}-${ctx.actor.departmentId}`,
    });
    await this.persistence.repos.learning.insertOwnership({
      memoryId: memory.id,
      originatingDepartmentId: entry.authorDepartmentId,
      primaryOwnerDepartmentId: ctx.actor.departmentId,
      recipientDepartmentId: ctx.actor.departmentId,
      classification: context.classification,
      collaborationId: context.id,
      retentionPolicy: "validated domain outcome",
      promotionReason: decision.reason,
      validationStatus: "validated",
      sourceMessageId: null,
      createdAt: this.now().toISOString(),
    });
    await this.persistence.repos.learning.updateEntry(entry.id, { status: "promoted", promotedMemoryId: memory.id });
    return { memoryId: memory.id, provenance: memory.provenance, reason: decision.reason };
  }

  async read(ctx: RequestContext, contextId: string) {
    this.authorizer.assert(ctx.actor, "learning:read");
    const context = await this.requireContext(contextId);
    const allowed = ctx.actor.role === "system_administrator" || (await this.isParticipant(ctx, contextId));
    if (!allowed) {
      throw new DomainError("AUTHORIZATION_DENIED", "This collaboration is outside the caller's department", 403);
    }
    if (ctx.actor.role === "system_administrator") {
      await this.audit(ctx, "collaboration.read", contextId, { classification: context.classification });
    }
    const entries = await this.persistence.repos.learning.listEntries(contextId);
    return {
      id: context.id,
      classification: context.classification,
      status: context.status,
      ownerDepartmentId: context.ownerDepartmentId,
      purpose: context.purpose,
      expiresAt: context.expiresAt,
      participants: await this.persistence.repos.learning.listParticipants(contextId),
      entries: entries.map((entry) => this.redact(entry, context)),
    };
  }

  async close(ctx: RequestContext, contextId: string) {
    this.authorizer.assert(ctx.actor, "learning:propose");
    const context = await this.requireContext(contextId);
    if (ctx.actor.departmentId !== context.ownerDepartmentId && ctx.actor.role !== "system_administrator") {
      throw new DomainError("AUTHORIZATION_DENIED", "Only the task owner can close the collaboration", 403);
    }
    const entries = await this.persistence.repos.learning.listEntries(contextId);
    for (const entry of entries) {
      if (entry.status === "active") {
        await this.persistence.repos.learning.updateEntry(entry.id, { status: "archived" });
      }
    }
    await this.persistence.repos.learning.updateContext(contextId, { status: "closed", closedAt: this.now().toISOString() });
    await this.audit(ctx, "collaboration.closed", contextId, { classification: context.classification });
    return { contextId, status: "closed" as const };
  }

  async sweep(ctx: RequestContext) {
    await this.requireMemoryDepartment(ctx);
    const result = await this.persistence.repos.learning.expireDue(this.now().toISOString());
    await this.audit(ctx, "collaboration.swept", "retention", result);
    return result;
  }

  async report(ctx: RequestContext) {
    await this.requireMemoryDepartment(ctx);
    const rows = await this.persistence.repos.learning.listOwnership();
    const violations: Array<{ memoryId: string; reason: string }> = [];
    const hashes = new Map<string, string[]>();
    for (const row of rows) {
      if (row.classification === "consultation" && row.recipientDepartmentId && row.recipientDepartmentId === row.primaryOwnerDepartmentId) {
        violations.push({ memoryId: row.memoryId, reason: "consultation stored as recipient memory" });
      }
      const memory = await this.persistence.repos.memories.findById(row.memoryId);
      if (!memory) {
        continue;
      }
      const owners = hashes.get(memory.contentHash) ?? [];
      owners.push(row.primaryOwnerDepartmentId);
      hashes.set(memory.contentHash, owners);
    }
    const duplicates = [...hashes.entries()].filter(([, owners]) => new Set(owners).size > 1).map(([contentHash, departments]) => ({ contentHash, departments }));
    return { violations, duplicates };
  }

  private async open(ctx: RequestContext, input: { recipientDepartmentId: string; question: string; idempotencyKey: string; classification: CollaborationClass; recipientStatus: "active" | "invited"; ttlMs?: number | null }) {
    this.authorizer.assert(ctx.actor, "learning:propose");
    if (!ctx.actor.departmentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Collaboration requires a department", 403);
    }
    if (input.recipientDepartmentId === ctx.actor.departmentId) {
      throw new DomainError("VALIDATION_ERROR", "A department cannot open a collaboration with itself", 422);
    }
    const existing = await this.persistence.repos.learning.findContextByKey(input.idempotencyKey);
    if (existing) {
      return { contextId: existing.id, repeated: true };
    }
    const expiresAt = input.ttlMs === null ? null : new Date(this.now().getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
    const context: CollaborationContextRecord = {
      id: randomUUID(),
      classification: input.classification,
      ownerDepartmentId: ctx.actor.departmentId,
      status: "open",
      purpose: input.classification === "joint" ? input.question.slice(0, 200) : input.classification,
      expiresAt,
      idempotencyKey: input.idempotencyKey,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
      closedAt: null,
    };
    const entry: CollaborationEntryRecord = {
      id: randomUUID(),
      contextId: context.id,
      authorDepartmentId: ctx.actor.departmentId,
      kind: "request_context",
      content: input.question,
      provenance: "user_provided",
      status: "active",
      expiresAt,
      promotedMemoryId: null,
      sourceMemoryId: null,
      idempotencyKey: `${input.idempotencyKey}:request`,
      createdAt: context.createdAt,
    };
    await this.persistence.transaction(async (repos) => {
      await repos.learning.insertContext(context);
      await repos.learning.insertParticipant({ id: randomUUID(), contextId: context.id, departmentId: ctx.actor.departmentId!, role: "owner", status: "active", createdAt: context.createdAt });
      await repos.learning.insertParticipant({ id: randomUUID(), contextId: context.id, departmentId: input.recipientDepartmentId, role: "contributor", status: input.recipientStatus, createdAt: context.createdAt });
      await repos.learning.insertEntry(entry);
      await repos.audit.append({
        eventType: "collaboration.opened",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "collaboration",
        targetId: context.id,
        action: "collaboration.opened",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: { classification: context.classification, status: context.status },
        metadata: { recipientDepartmentId: input.recipientDepartmentId },
      });
    });
    if (ctx.actor.agentId) {
      await this.messages.send(ctx, {
        messageType: "COLLABORATION_REQUEST",
        recipientDepartmentId: input.recipientDepartmentId,
        priority: 5,
        idempotencyKey: `collab.notice.${context.id}`,
        payload: { subject: input.classification, objective: input.question.slice(0, 4000), requestedContribution: "bounded answer", deadline: null },
      });
    }
    return { contextId: context.id, entryId: entry.id, repeated: false };
  }

  private redact(entry: CollaborationEntryRecord, context: CollaborationContextRecord): CollaborationEntryRecord {
    if (entry.status === "active" && context.status === "open" && !this.expired(entry, context)) {
      return entry;
    }
    return { ...entry, content: "" };
  }

  private expired(entry: CollaborationEntryRecord, context: CollaborationContextRecord): boolean {
    const stamp = entry.expiresAt ?? context.expiresAt;
    return stamp !== null && Date.parse(stamp) <= this.now().getTime();
  }

  private async requireContext(id: string): Promise<CollaborationContextRecord> {
    const context = await this.persistence.repos.learning.findContext(id);
    if (!context) {
      throw notFound("Collaboration", id);
    }
    return context;
  }

  private async requireEntry(id: string): Promise<CollaborationEntryRecord> {
    const entry = await this.persistence.repos.learning.findEntry(id);
    if (!entry) {
      throw notFound("Collaboration entry", id);
    }
    return entry;
  }

  private async requireOpen(id: string): Promise<CollaborationContextRecord> {
    const context = await this.requireContext(id);
    if (context.status !== "open") {
      throw new DomainError("INVALID_STATE", "The collaboration is closed", 409);
    }
    return context;
  }

  private async requireActive(ctx: RequestContext, context: CollaborationContextRecord) {
    if (ctx.actor.role === "system_administrator") {
      return;
    }
    const participants = await this.persistence.repos.learning.listParticipants(context.id);
    const mine = participants.find((row) => row.departmentId === ctx.actor.departmentId && row.status === "active");
    if (!mine) {
      throw new DomainError("AUTHORIZATION_DENIED", "The department is not an active participant", 403);
    }
  }

  private async isParticipant(ctx: RequestContext, contextId: string): Promise<boolean> {
    const participants = await this.persistence.repos.learning.listParticipants(contextId);
    return participants.some((row) => row.departmentId === ctx.actor.departmentId && row.status !== "removed");
  }

  private async bothActive(contextId: string): Promise<boolean> {
    const participants = await this.persistence.repos.learning.listParticipants(contextId);
    return participants.length >= 2 && participants.every((row) => row.status === "active");
  }

  private async otherDepartment(contextId: string, departmentId: string): Promise<string> {
    const participants = await this.persistence.repos.learning.listParticipants(contextId);
    const other = participants.find((row) => row.departmentId !== departmentId);
    if (!other) {
      throw new DomainError("INVALID_STATE", "The collaboration has no recipient", 409);
    }
    return other.departmentId;
  }

  private async requireMemoryDepartment(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "learning:read");
    if (ctx.actor.role === "system_administrator") {
      return;
    }
    const department = ctx.actor.departmentId ? await this.persistence.repos.departments.findById(ctx.actor.departmentId) : null;
    if (department?.slug !== "memory-and-forgetting") {
      throw new DomainError("AUTHORIZATION_DENIED", "Retention sweep belongs to Memory & Forgetting", 403);
    }
  }

  private async audit(ctx: RequestContext, action: string, targetId: string, metadata: Record<string, unknown>) {
    await this.persistence.repos.audit.append({
      eventType: action,
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "collaboration",
      targetId,
      action,
      correlationId: ctx.correlationId,
      beforeState: null,
      afterState: null,
      metadata,
    });
  }
}
