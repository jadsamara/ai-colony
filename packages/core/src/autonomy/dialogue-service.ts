import { randomUUID } from "node:crypto";
import { SYSTEM_ADMINISTRATOR_ID, type DialogueKind } from "@ai-colony/contracts";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import { ROLE_PERMISSIONS } from "../governance/permissions.js";
import type { InferenceProvider } from "../inference/provider.js";
import type { MessagingService } from "../messaging/message-service.js";
import type { InferenceRoute } from "../objectives/objective-service.js";
import type { Persistence, Repositories } from "../ports/repositories.js";
import { logConversationInference, selectConversationInference } from "./conversation-routing.js";
import { dialoguePrompt, redactMessages } from "./policy.js";
import type { ConversationRecord, ConversationTurnRecord, MembershipAction, MembershipState, TurnClaim } from "./repository.js";
import type { ParticipantRole } from "./repository.js";
import { buildDialogueContext, maySpeak, orchestrationRecommendation } from "./speakers.js";
import { routingIdempotencyKey } from "./department-routing.js";
import { DepartmentRoutingService } from "./department-routing-service.js";
import type { DepartmentRoutingResult } from "./department-routing-service.js";

const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const CLAIM_LEASE_MS = 15_000;
const AVAILABLE = new Set(["idle", "running", "paused"]);

type Route = Pick<
  InferenceRoute,
  | "alias"
  | "temperature"
  | "maxOutputTokens"
  | "timeoutMs"
  | "dedicatedRouting"
  | "rates"
  | "globalConcurrency"
  | "departmentConcurrency"
>;

export class DialogueService {
  private readonly routing: DepartmentRoutingService;

  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly messages: MessagingService,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.routing = new DepartmentRoutingService(persistence, authorizer, now);
  }

  /**
   * Hybrid routing entry: select departments, then open a conversation.
   * Compatible design for a single specialist: opener (requester) + primary specialist.
   * Does not invent a fictitious peer department.
   */
  async openHybrid(
    ctx: RequestContext,
    provider: InferenceProvider,
    route: Route,
    input: {
      task: string;
      topic?: string;
      objectiveId?: string | null;
      kind: DialogueKind;
      instruction: string;
      idempotencyKey: string;
      routingIdempotencyKey?: string;
    },
  ): Promise<{ turn: ConversationTurnRecord; routing: DepartmentRoutingResult }> {
    this.requireAgent(ctx);
    const decision = await this.routing.route(ctx, provider, route, {
      task: input.task,
      objectiveId: input.objectiveId ?? null,
      idempotencyKey: routingIdempotencyKey(input.routingIdempotencyKey, input.idempotencyKey),
      excludeDepartmentId: ctx.actor.departmentId,
    });
    if (decision.approvalRequired && ctx.actor.role !== "system_administrator" && ctx.actor.role !== "ceo_agent") {
      throw new DomainError(
        "APPROVAL_REQUIRED",
        "This routing decision requires CEO or system administrator approval before opening a conversation",
        403,
        { decisionId: decision.decisionId, method: decision.method },
      );
    }
    try {
      const turn = await this.open(ctx, provider, route, {
        recipientDepartmentId: decision.primaryDepartmentId,
        participantDepartmentIds: decision.additionalDepartmentIds,
        topic: (input.topic ?? input.task).slice(0, 500),
        objectiveId: input.objectiveId ?? null,
        kind: input.kind,
        instruction: input.instruction,
        idempotencyKey: input.idempotencyKey,
      });
      return { turn, routing: decision };
    } catch (error) {
      // Routing decision remains durable. Retry with the same keys reuses the decision and turn idempotency.
      if (error instanceof DomainError) {
        throw new DomainError(error.code, error.message, error.statusCode, {
          ...(error.details ?? {}),
          routingDecisionId: decision.decisionId,
          routingMethod: decision.method,
          openFailed: true,
        });
      }
      throw error;
    }
  }

  async routeDepartments(
    ctx: RequestContext,
    provider: InferenceProvider,
    route: Route,
    input: {
      task: string;
      objectiveId?: string | null;
      idempotencyKey: string;
      maxParticipants?: number;
    },
  ): Promise<DepartmentRoutingResult> {
    return this.routing.route(ctx, provider, route, {
      ...input,
      excludeDepartmentId: ctx.actor.departmentId,
    });
  }

  async open(
    ctx: RequestContext,
    provider: InferenceProvider,
    route: Route,
    input: { recipientDepartmentId: string; participantDepartmentIds?: string[]; topic: string; objectiveId?: string | null; kind: DialogueKind; instruction: string; idempotencyKey: string },
  ): Promise<ConversationTurnRecord> {
    this.requireAgent(ctx);
    this.requireKey(input.idempotencyKey);
    const existing = await this.persistence.repos.autonomy.findTurnByKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    if (input.recipientDepartmentId === ctx.actor.departmentId) {
      throw new DomainError("VALIDATION_ERROR", "A department cannot open a conversation with itself", 422);
    }
    const recipient = await this.requireConversationDepartment(input.recipientDepartmentId);
    const sender = await this.requireConversationDepartment(ctx.actor.departmentId ?? "");
    const extras = await this.additionalParticipants(sender.id, recipient.id, input.participantDepartmentIds ?? []);
    const settings = await this.persistence.repos.autonomy.settings();
    if (2 + extras.length > settings.maxConversationParticipants) {
      throw new DomainError("BUDGET_EXCEEDED", "The participant limit is already in use", 409);
    }
    if ((await this.persistence.repos.autonomy.countOpenConversations()) >= settings.maxConversations) {
      throw new DomainError("BUDGET_EXCEEDED", "The conversation limit is already in use", 409);
    }
    const objective = await this.objectiveForOpen(input.objectiveId ?? null);
    const conversationId = randomUUID();
    const prompt = await this.promptFor(sender, input.kind, input.topic, input.instruction, [], objective?.text ?? null, input.instruction.trim());
    const selected = this.routed(provider, route, sender);
    const result = await selected.provider.generate({
      requestId: randomUUID(),
      registryModelId: "00000000-0000-4000-8000-000000000101",
      modelAlias: route.alias,
      messages: prompt,
      temperature: route.temperature,
      maxOutputTokens: route.maxOutputTokens,
      timeoutMs: route.timeoutMs,
      jsonObject: false,
    });
    const body = result.text.trim();
    if (!body) {
      throw new DomainError("VALIDATION_ERROR", "The department model returned an empty turn", 422);
    }
    const sequence = await this.persistence.transaction(async (repos) => {
      await repos.autonomy.insertConversation({
        id: conversationId,
        topic: input.topic.trim(),
        objectiveId: input.objectiveId ?? null,
        openedByDepartmentId: sender.id,
        status: "open",
        maxMessages: settings.maxConversationMessages,
        maxTokens: settings.conversationHardTokenCeiling,
        maxDurationMs: settings.maxDurationMs,
        openingInstruction: input.instruction.trim(),
      });
      await this.seat(repos, ctx, {
        conversationId,
        departmentId: sender.id,
        action: "joined",
        membership: "active",
        role: "opener",
        reason: "Opened the conversation",
        invitedByDepartmentId: null,
        joinedAt: this.now(),
        removedAt: null,
      });
      await this.seat(repos, ctx, {
        conversationId,
        departmentId: recipient.id,
        action: "joined",
        membership: "active",
        role: this.roleFor(recipient.slug, "participant"),
        reason: "Named as a participant when the conversation opened",
        invitedByDepartmentId: sender.id,
        joinedAt: this.now(),
        removedAt: null,
      });
      for (const extra of extras) {
        await this.seat(repos, ctx, {
          conversationId,
          departmentId: extra.id,
          action: "joined",
          membership: "active",
          role: this.roleFor(extra.slug, "participant"),
          reason: "Named as a participant when the conversation opened",
          invitedByDepartmentId: sender.id,
          joinedAt: this.now(),
          removedAt: null,
        });
      }
      return repos.autonomy.allocateSequence(conversationId);
    });
    await this.persistence.repos.autonomy.saveConversation(conversationId, { lastInferenceEndpoint: selected.metadata });
    return this.persistTurn(ctx, {
      idempotencyKey: input.idempotencyKey,
      conversationId,
      departmentId: sender.id,
      kind: input.kind,
      addressedDepartmentId: recipient.id,
      parentMessageId: null,
      sequence,
      body,
      prompt: redactMessages(prompt),
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      updatedAt: this.now().toISOString(),
    });
  }

  async speak(
    ctx: RequestContext,
    provider: InferenceProvider,
    route: Route,
    conversationId: string,
    input: { kind: DialogueKind; instruction: string; idempotencyKey: string; parentMessageId?: string | null; addressedDepartmentId?: string | null; prepared?: { body: string; prompt: Array<{ role: string; content: string }>; inputTokens: number; outputTokens: number } },
  ): Promise<ConversationTurnRecord> {
    this.requireAgent(ctx);
    this.requireKey(input.idempotencyKey);
    const existing = await this.persistence.repos.autonomy.findTurnByKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const held = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (
      held?.runnerStatus === "running" &&
      held.runnerLeaseUntil &&
      Date.parse(held.runnerLeaseUntil) > this.now().getTime() &&
      !input.idempotencyKey.startsWith("runner:")
    ) {
      throw new DomainError("INVALID_STATE", "The autonomous runner holds this conversation", 409);
    }
    await this.requireParticipant(ctx, conversationId);
    await this.maintain();
    const gate = await this.persistence.transaction(async (repos) => this.claim(repos, ctx, conversationId, input));
    if (gate.status === "turn") {
      return gate.turn;
    }
    if (gate.status === "missing") {
      throw notFound("Conversation", conversationId);
    }
    if (gate.status === "closed") {
      throw this.closedError(gate.reason);
    }
    if (gate.status === "budget") {
      await this.finishClosed(this.persistence.repos, conversationId, "terminated", gate.reason, ctx);
      throw new DomainError(
        "BUDGET_EXCEEDED",
        gate.reason === "token_limit" ? "The conversation reached its token limit" : "The conversation reached its message limit",
        409,
      );
    }
    if (gate.status === "pending") {
      throw new DomainError("INVALID_STATE", "This turn is already being generated", 409);
    }
    if (gate.status === "speaker") {
      throw new DomainError("INVALID_STATE", gate.reason, 409);
    }
    if (gate.status === "address") {
      throw new DomainError("VALIDATION_ERROR", "The addressed department is not an active participant", 422);
    }
    if (gate.status === "resume") {
      return this.persistTurn(ctx, gate.claim);
    }
    if (input.prepared) {
      if (gate.status !== "generate") {
        throw new DomainError("INVALID_STATE", "The prepared turn could not be stored", 409);
      }
      return this.storePrepared(ctx, input.idempotencyKey, input.prepared, gate.claim);
    }
    const objective = await this.objectiveForSpeak(conversationId, gate.objectiveId);
    const sender = await this.persistence.repos.autonomy.department(ctx.actor.departmentId ?? "");
    if (!sender) {
      throw new DomainError("AUTHORIZATION_DENIED", "The sender department is unavailable", 403);
    }
    const prior = await this.persistence.repos.autonomy.listTurns(conversationId);
    const stored = await this.persistence.repos.autonomy.findConversation(conversationId);
    const prompt = await this.promptFor(sender, input.kind, gate.topic, input.instruction, prior, objective, stored?.openingInstruction ?? null);
    const selected = this.routed(provider, route, sender);
    const result = await selected.provider.generate({
      requestId: randomUUID(),
      registryModelId: "00000000-0000-4000-8000-000000000101",
      modelAlias: route.alias,
      messages: prompt,
      temperature: route.temperature,
      maxOutputTokens: route.maxOutputTokens,
      timeoutMs: route.timeoutMs,
      jsonObject: false,
    });
    const body = result.text.trim();
    if (!body) {
      throw new DomainError("VALIDATION_ERROR", "The department model returned an empty turn", 422);
    }
    await this.persistence.repos.autonomy.saveConversation(conversationId, { lastInferenceEndpoint: selected.metadata });
    const own = [...prior].reverse().find((turn) => turn.departmentId === sender.id);
    if (own && own.body === body) {
      await this.finishClosed(this.persistence.repos, conversationId, "terminated", "loop", ctx);
      throw new DomainError("INVALID_STATE", "The conversation repeated the same turn and was closed", 409);
    }
    const storedPrompt = redactMessages(prompt);
    await this.persistence.repos.autonomy.saveClaimBody(input.idempotencyKey, {
      body,
      prompt: storedPrompt,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      at: this.now(),
    });
    if (prompt.some((message) => message.content.includes("summary (not a verbatim transcript)"))) {
      const summary = prompt.find((message) => message.role === "user")?.content.split("Earlier context:\n")[1]?.split("\nRecent transcript:")[0]?.trim();
      if (summary) {
        await this.persistence.repos.autonomy.saveConversation(conversationId, { contextSummary: summary });
      }
    }
    return this.persistTurn(ctx, {
      ...gate.claim,
      body,
      prompt: storedPrompt,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    });
  }

  async invite(
    ctx: RequestContext,
    provider: InferenceProvider,
    route: Route,
    conversationId: string,
    input: { departmentId: string; instruction: string; idempotencyKey: string; prepared?: { body: string; prompt: Array<{ role: string; content: string }>; inputTokens: number; outputTokens: number } },
  ): Promise<ConversationTurnRecord> {
    this.requireAgent(ctx);
    await this.requireParticipant(ctx, conversationId);
    const target = await this.requireAvailable(input.departmentId);
    if (target.id === ctx.actor.departmentId) {
      throw new DomainError("VALIDATION_ERROR", "A department cannot invite itself", 422);
    }
    await this.assertSeatAvailable(conversationId, target.id);
    const turn = await this.speak(ctx, provider, route, conversationId, {
      kind: "proposal",
      instruction: input.instruction,
      idempotencyKey: input.idempotencyKey,
      addressedDepartmentId: null,
      prepared: input.prepared,
    });
    const settings = await this.persistence.repos.autonomy.settings();
    await this.persistence.transaction(async (repos) => {
      const locked = await repos.autonomy.lockConversation(conversationId);
      if (!locked || locked.status !== "open") {
        throw new DomainError("INVALID_STATE", "The conversation is closed", 409);
      }
      const membership = await repos.autonomy.listMembership(conversationId);
      const existing = membership.find((item) => item.departmentId === target.id);
      if (existing?.membership === "active" || existing?.membership === "invited") {
        return;
      }
      const seated = membership.filter((item) => item.membership === "active" || item.membership === "invited").length;
      if (seated >= settings.maxConversationParticipants) {
        throw new DomainError("BUDGET_EXCEEDED", "The participant limit is already in use", 409);
      }
      await this.seat(repos, ctx, {
        conversationId,
        departmentId: target.id,
        action: "invited",
        membership: "invited",
        role: this.roleFor(target.slug, "specialist"),
        reason: input.instruction.slice(0, 500),
        invitedByDepartmentId: ctx.actor.departmentId,
        joinedAt: null,
        removedAt: null,
      });
    });
    return turn;
  }

  async seatInvitee(ctx: RequestContext, conversationId: string, departmentId: string, reason: string): Promise<void> {
    this.requireAgent(ctx);
    await this.requireParticipant(ctx, conversationId);
    const target = await this.requireAvailable(departmentId);
    if (target.id === ctx.actor.departmentId) {
      throw new DomainError("VALIDATION_ERROR", "A department cannot invite itself", 422);
    }
    await this.assertSeatAvailable(conversationId, target.id);
    const settings = await this.persistence.repos.autonomy.settings();
    await this.persistence.transaction(async (repos) => {
      const locked = await repos.autonomy.lockConversation(conversationId);
      if (!locked || locked.status !== "open") {
        throw new DomainError("INVALID_STATE", "The conversation is closed", 409);
      }
      const membership = await repos.autonomy.listMembership(conversationId);
      const existing = membership.find((item) => item.departmentId === target.id);
      if (existing?.membership === "active" || existing?.membership === "invited") {
        return;
      }
      const seated = membership.filter((item) => item.membership === "active" || item.membership === "invited").length;
      if (seated >= settings.maxConversationParticipants) {
        throw new DomainError("BUDGET_EXCEEDED", "The participant limit is already in use", 409);
      }
      await this.seat(repos, ctx, {
        conversationId,
        departmentId: target.id,
        action: "invited",
        membership: "invited",
        role: this.roleFor(target.slug, "specialist"),
        reason: reason.slice(0, 500),
        invitedByDepartmentId: ctx.actor.departmentId,
        joinedAt: null,
        removedAt: null,
      });
    });
  }

  async accept(ctx: RequestContext, conversationId: string): Promise<void> {
    await this.answerInvite(ctx, conversationId, "accepted", "active", "Accepted the invitation");
  }

  async decline(ctx: RequestContext, conversationId: string, reason = "Declined the invitation"): Promise<void> {
    await this.answerInvite(ctx, conversationId, "declined", "declined", reason.slice(0, 500));
  }

  async remove(ctx: RequestContext, conversationId: string, departmentId: string, reason: string): Promise<void> {
    this.requireAgent(ctx);
    await this.requireParticipant(ctx, conversationId);
    const trimmed = reason.trim();
    if (!trimmed) {
      throw new DomainError("VALIDATION_ERROR", "A removal reason is required", 422);
    }
    await this.persistence.transaction(async (repos) => {
      const locked = await repos.autonomy.lockConversation(conversationId);
      if (!locked) {
        throw notFound("Conversation", conversationId);
      }
      if (locked.status !== "open") {
        throw new DomainError("INVALID_STATE", "The conversation is closed", 409);
      }
      const membership = await repos.autonomy.listMembership(conversationId);
      const target = membership.find((item) => item.departmentId === departmentId && item.membership === "active");
      if (!target) {
        throw new DomainError("INVALID_STATE", "That department is not an active participant", 409);
      }
      await this.seat(repos, ctx, {
        conversationId,
        departmentId,
        action: "removed",
        membership: "removed",
        reason: trimmed.slice(0, 500),
        invitedByDepartmentId: target.invitedByDepartmentId,
        joinedAt: target.joinedAt ? new Date(target.joinedAt) : null,
        removedAt: this.now(),
      });
      const active = await repos.autonomy.listParticipants(conversationId);
      if (active.length < 2) {
        await this.finishClosed(repos, conversationId, "unresolved", "below_minimum", ctx);
      }
    });
  }

  async terminate(ctx: RequestContext, conversationId: string, reason: string): Promise<ConversationRecord> {
    this.authorizer.assert(ctx.actor, "autonomy:manage");
    const conversation = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!conversation) {
      throw notFound("Conversation", conversationId);
    }
    if (conversation.status === "open") {
      await this.finishClosed(this.persistence.repos, conversationId, "terminated", reason.trim() || "administrator", ctx);
    }
    const stored = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!stored) {
      throw notFound("Conversation", conversationId);
    }
    return stored;
  }

  async nextSpeaker(ctx: RequestContext, conversationId: string) {
    if (!this.canModerate(ctx)) {
      await this.requireParticipant(ctx, conversationId);
    }
    const conversation = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!conversation) {
      throw notFound("Conversation", conversationId);
    }
    if (conversation.status !== "open") {
      return { speaker: null };
    }
    const ids = await this.persistence.repos.autonomy.listParticipants(conversationId);
    const participants = [];
    for (const id of ids) {
      const department = await this.persistence.repos.autonomy.department(id);
      if (department) {
        participants.push(department);
      }
    }
    const turns = await this.persistence.repos.autonomy.listTurns(conversationId);
    return {
      source: "orchestration" as const,
      speaker: orchestrationRecommendation({
        participants,
        turns,
        topic: conversation.topic,
        remainingMessages: Math.max(0, conversation.maxMessages - conversation.messageCount),
      }),
    };
  }

  async read(ctx: RequestContext, conversationId: string) {
    const visibility = await this.visibility(ctx, conversationId);
    const membership = await this.persistence.repos.autonomy.listMembership(conversationId);
    const events = await this.persistence.repos.autonomy.listMembershipEvents(conversationId);
    let turns = visibility.mode === "invited" ? [] : await this.persistence.repos.autonomy.listTurns(conversationId);
    if (visibility.mode === "removed" && visibility.removedAt) {
      const cutoff = Date.parse(visibility.removedAt);
      turns = turns.filter((turn) => Date.parse(turn.createdAt) <= cutoff);
    }
    return {
      conversation: visibility.conversation,
      participants: membership,
      activeDepartmentIds: membership.filter((item) => item.membership === "active").map((item) => item.departmentId),
      events,
      transcriptVisible: visibility.mode !== "invited",
      turns: turns.map((turn) => ({ ...turn, prompt: redactMessages(turn.prompt) })),
    };
  }

  async list(ctx: RequestContext) {
    this.authorizer.assertAny(ctx.actor, ["message:read", "message:admin", "autonomy:manage"]);
    const rows = await this.persistence.repos.autonomy.listConversations(50);
    if (this.canModerate(ctx)) {
      return rows;
    }
    const visible: ConversationRecord[] = [];
    for (const row of rows) {
      const membership = await this.persistence.repos.autonomy.listMembership(row.id);
      const mine = membership.find((item) => item.departmentId === ctx.actor.departmentId);
      if (mine && mine.membership !== "declined") {
        visible.push(row);
      }
    }
    return visible;
  }

  async search(ctx: RequestContext, conversationId: string, query: string, limit = 5) {
    const visibility = await this.visibility(ctx, conversationId);
    const found = await this.persistence.repos.autonomy.searchTurns(conversationId, query, Math.min(Math.max(limit, 1), 8));
    const cutoff = visibility.mode === "removed" && visibility.removedAt ? Date.parse(visibility.removedAt) : null;
    const visible = visibility.mode === "invited" ? [] : cutoff === null ? found : found.filter((turn) => Date.parse(turn.createdAt) <= cutoff);
    const tokens = visible.reduce((sum, turn) => sum + Math.max(1, Math.ceil(turn.body.length / 4)), 0);
    const conversation = visibility.conversation;
    if (conversation.inputTokens + conversation.outputTokens + tokens > conversation.maxTokens) {
      throw new DomainError("BUDGET_EXCEEDED", "The conversation reached its token limit", 409);
    }
    await this.persistence.repos.autonomy.addContextTokens(conversationId, tokens);
    await this.persistence.repos.autonomy.insertContextEvent({
      id: randomUUID(),
      conversationId,
      departmentId: ctx.actor.departmentId,
      kind: "search",
      query: query.slice(0, 200),
      messageIds: visible.map((turn) => turn.id),
      tokens,
    });
    return {
      turns: visible.map((turn) => ({
        id: turn.id,
        messageId: turn.messageId,
        departmentSlug: turn.departmentSlug,
        kind: turn.kind,
        body: turn.body,
        createdAt: turn.createdAt,
      })),
    };
  }

  async openSeated(
    ctx: RequestContext,
    input: { topic: string; objectiveId?: string | null; departmentIds: string[]; parentConversationId: string | null },
  ): Promise<string> {
    this.requireAgent(ctx);
    const unique = [...new Set(input.departmentIds)];
    if (unique.length < 2 || unique.length > 4) {
      throw new DomainError("VALIDATION_ERROR", "A working group needs two to four departments", 422);
    }
    const settings = await this.persistence.repos.autonomy.settings();
    const conversationId = randomUUID();
    await this.persistence.transaction(async (repos) => {
      await repos.autonomy.insertConversation({
        id: conversationId,
        topic: input.topic.trim(),
        objectiveId: input.objectiveId ?? null,
        openedByDepartmentId: ctx.actor.departmentId ?? unique[0] ?? "",
        status: "open",
        maxMessages: settings.maxConversationMessages,
        maxTokens: settings.conversationHardTokenCeiling,
        maxDurationMs: settings.maxDurationMs,
        openingInstruction: input.topic.trim(),
      });
      if (input.parentConversationId) {
        await repos.autonomy.saveConversation(conversationId, { parentConversationId: input.parentConversationId });
      }
      for (const departmentId of unique) {
        await this.requireAvailable(departmentId);
        await this.seat(repos, ctx, {
          conversationId,
          departmentId,
          action: "joined",
          membership: "active",
          reason: "Seated in a working group",
          invitedByDepartmentId: ctx.actor.departmentId,
          joinedAt: this.now(),
          removedAt: null,
        });
      }
    });
    return conversationId;
  }

  async maintain(): Promise<number> {
    const open = (await this.persistence.repos.autonomy.listConversations(100)).filter((row) => row.status === "open");
    let closed = 0;
    const actor = this.systemContext();
    for (const conversation of open) {
      if (conversation.objectiveId) {
        const run = await this.persistence.repos.objectives.getRun(conversation.objectiveId);
        if (run && (run.status === "completed" || run.status === "failed" || run.status === "cancelled")) {
          await this.finishClosed(this.persistence.repos, conversation.id, "terminated", `objective_${run.status}`, actor);
          closed += 1;
          continue;
        }
      }
      if (this.now().getTime() - Date.parse(conversation.lastTurnAt) < conversation.maxDurationMs) {
        continue;
      }
      await this.finishClosed(this.persistence.repos, conversation.id, "terminated", "inactivity", actor);
      closed += 1;
    }
    return closed;
  }

  private async claim(
    repos: Repositories,
    ctx: RequestContext,
    conversationId: string,
    input: { kind: DialogueKind; idempotencyKey: string; parentMessageId?: string | null; addressedDepartmentId?: string | null },
  ) {
    const locked = await repos.autonomy.lockConversation(conversationId);
    if (!locked) {
      return { status: "missing" as const };
    }
    if (locked.status !== "open") {
      return { status: "closed" as const, reason: locked.closeReason };
    }
    if (locked.messageCount >= locked.maxMessages) {
      return { status: "budget" as const, reason: "message_limit" as const };
    }
    if (locked.inputTokens + locked.outputTokens >= locked.maxTokens) {
      return { status: "budget" as const, reason: "token_limit" as const };
    }
    const turn = await repos.autonomy.findTurnByKey(input.idempotencyKey);
    if (turn) {
      return { status: "turn" as const, turn };
    }
    const claim = await repos.autonomy.findClaim(input.idempotencyKey);
    if (claim && claim.departmentId !== ctx.actor.departmentId) {
      return { status: "speaker" as const, reason: "This idempotency key belongs to another department" };
    }
    if (claim?.body && claim.prompt) {
      return { status: "resume" as const, claim };
    }
    if (claim && this.now().getTime() - Date.parse(claim.updatedAt) < CLAIM_LEASE_MS) {
      return { status: "pending" as const };
    }
    const addressedDepartmentId = input.addressedDepartmentId ?? null;
    const participants = await repos.autonomy.listParticipants(conversationId);
    if (!claim) {
      const turns = await repos.autonomy.listTurns(conversationId);
      const decision = maySpeak({
        departmentId: ctx.actor.departmentId ?? "",
        participantIds: participants,
        turns,
      });
      if (!decision.allowed) {
        return { status: "speaker" as const, reason: decision.reason };
      }
      if (addressedDepartmentId && (addressedDepartmentId === ctx.actor.departmentId || !participants.includes(addressedDepartmentId))) {
        return { status: "address" as const };
      }
    }
    const sequence = claim?.sequence ?? (await repos.autonomy.allocateSequence(conversationId));
    if (!claim) {
      await repos.autonomy.insertClaim({
        idempotencyKey: input.idempotencyKey,
        conversationId,
        departmentId: ctx.actor.departmentId ?? "",
        kind: input.kind,
        addressedDepartmentId,
        parentMessageId: input.parentMessageId ?? null,
        sequence,
      });
    }
    return {
      status: "generate" as const,
      topic: locked.topic,
      objectiveId: locked.objectiveId,
      claim: {
        idempotencyKey: input.idempotencyKey,
        conversationId,
        departmentId: claim?.departmentId ?? ctx.actor.departmentId ?? "",
        kind: claim?.kind ?? input.kind,
        addressedDepartmentId: claim?.addressedDepartmentId ?? addressedDepartmentId,
        parentMessageId: claim?.parentMessageId ?? input.parentMessageId ?? null,
        sequence,
        body: null,
        prompt: null,
        inputTokens: null,
        outputTokens: null,
        updatedAt: this.now().toISOString(),
      } satisfies TurnClaim,
    };
  }

  private async persistTurn(ctx: RequestContext, claim: TurnClaim): Promise<ConversationTurnRecord> {
    const body = claim.body ?? "";
    if (!body) {
      throw new DomainError("INVALID_STATE", "The stored turn has no message body", 409);
    }
    const conversation = await this.persistence.repos.autonomy.findConversation(claim.conversationId);
    if (!conversation) {
      throw notFound("Conversation", claim.conversationId);
    }
    const participants = await this.persistence.repos.autonomy.listParticipants(claim.conversationId);
    const membership = await this.persistence.repos.autonomy.listMembership(claim.conversationId);
    const evaluative = membership.find((item) => item.departmentId === claim.departmentId)?.role === "evaluator"
      && (claim.kind === "close" || claim.kind === "resolution");
    const kind = evaluative ? "response" : claim.kind;
    const recipient = claim.addressedDepartmentId ?? this.groupRecipient(participants, claim.departmentId, conversation.openedByDepartmentId);
    const sent = await this.messages.send(ctx, {
      messageType: "DEPARTMENT_DIALOGUE",
      recipientDepartmentId: recipient,
      correlationId: claim.conversationId,
      causationId: claim.parentMessageId,
      replyToMessageId: claim.parentMessageId,
      priority: 4,
      idempotencyKey: claim.idempotencyKey,
      payload: {
        conversationId: claim.conversationId,
        kind,
        topic: conversation.topic,
        body,
        objectiveId: conversation.objectiveId,
        parentMessageId: claim.parentMessageId,
        addressedDepartmentId: claim.addressedDepartmentId,
      },
      metadata: {
        kind: "department-dialogue",
        conversationId: claim.conversationId,
        audience: claim.addressedDepartmentId ? "department" : "group",
        addressedDepartmentId: claim.addressedDepartmentId,
      },
    });
    if (sent.replayed) {
      const replayed = await this.persistence.repos.autonomy.findTurnByKey(claim.idempotencyKey);
      if (replayed) {
        return replayed;
      }
    }
    await this.persistence.repos.autonomy.insertTurn({
      id: randomUUID(),
      conversationId: claim.conversationId,
      messageId: sent.message.messageId,
      departmentId: claim.departmentId,
      kind,
      body,
      addressedDepartmentId: claim.addressedDepartmentId,
      sequence: claim.sequence,
      parentMessageId: claim.parentMessageId,
      prompt: claim.prompt ?? [],
      idempotencyKey: claim.idempotencyKey,
    });
    await this.persistence.repos.autonomy.recordTurnUsage(claim.conversationId, {
      requests: 1,
      inputTokens: claim.inputTokens ?? 0,
      outputTokens: claim.outputTokens ?? 0,
      at: this.now(),
    });
    if (!evaluative && (kind === "resolution" || kind === "close")) {
      await this.finishClosed(
        this.persistence.repos,
        claim.conversationId,
        claim.kind === "resolution" ? "resolved" : "unresolved",
        claim.kind,
        ctx,
      );
    }
    const stored = await this.persistence.repos.autonomy.findTurnByKey(claim.idempotencyKey);
    if (!stored) {
      throw notFound("ConversationTurn", claim.idempotencyKey);
    }
    return stored;
  }

  private async storePrepared(
    ctx: RequestContext,
    idempotencyKey: string,
    prepared: { body: string; prompt: Array<{ role: string; content: string }>; inputTokens: number; outputTokens: number },
    claim: TurnClaim,
  ): Promise<ConversationTurnRecord> {
    const body = prepared.body.trim();
    if (!body) {
      throw new DomainError("VALIDATION_ERROR", "The department model returned an empty turn", 422);
    }
    const prior = await this.persistence.repos.autonomy.listTurns(claim.conversationId);
    const own = [...prior].reverse().find((turn) => turn.departmentId === claim.departmentId);
    if (own && own.body === body) {
      await this.finishClosed(this.persistence.repos, claim.conversationId, "terminated", "loop", ctx);
      throw new DomainError("INVALID_STATE", "The conversation repeated the same turn and was closed", 409);
    }
    const prompt = redactMessages(prepared.prompt);
    await this.persistence.repos.autonomy.saveClaimBody(idempotencyKey, {
      body,
      prompt,
      inputTokens: prepared.inputTokens,
      outputTokens: prepared.outputTokens,
      at: this.now(),
    });
    return this.persistTurn(ctx, {
      ...claim,
      body,
      prompt,
      inputTokens: prepared.inputTokens,
      outputTokens: prepared.outputTokens,
    });
  }

  private async promptFor(
    sender: { id: string; name: string },
    kind: string,
    topic: string,
    instruction: string,
    prior: ConversationTurnRecord[],
    objective: string | null,
    openingInstruction: string | null,
  ) {
    const settings = await this.persistence.repos.autonomy.settings();
    const lines = prior.map((turn) => ({ id: turn.id, department: turn.departmentSlug, kind: turn.kind, body: turn.body }));
    const context = buildDialogueContext(lines, settings.contextTokenBudget);
    const quote = (turn: ConversationTurnRecord) => `${turn.departmentSlug} (${turn.kind}): ${turn.body}`;
    return dialoguePrompt({
      departmentName: sender.name,
      topic,
      kind,
      instruction,
      openingInstruction,
      transcript: context.verbatim,
      summary: context.summary,
      objective,
      directed: prior.filter((turn) => turn.addressedDepartmentId === sender.id).slice(-3).map(quote),
      disagreements: prior
        .filter((turn) => turn.kind === "disagreement" || turn.kind === "counterargument" || turn.kind === "challenge")
        .slice(-4)
        .map(quote),
      evidence: prior.filter((turn) => turn.kind === "evidence").slice(-4).map(quote),
    });
  }

  private async objectiveForOpen(objectiveId: string | null): Promise<{ text: string } | null> {
    if (!objectiveId) {
      return null;
    }
    const run = await this.persistence.repos.objectives.getRun(objectiveId);
    if (!run) {
      throw notFound("Objective", objectiveId);
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new DomainError("INVALID_STATE", "The objective is no longer open", 409);
    }
    if (run.executionPath === "direct") {
      throw new DomainError("INVALID_STATE", "A direct objective does not open a department conversation", 409);
    }
    return { text: run.objective };
  }

  private async objectiveForSpeak(conversationId: string, objectiveId: string | null): Promise<string | null> {
    if (!objectiveId) {
      return null;
    }
    const run = await this.persistence.repos.objectives.getRun(objectiveId);
    if (!run) {
      return null;
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      await this.finishClosed(this.persistence.repos, conversationId, "terminated", `objective_${run.status}`, this.systemContext());
      throw new DomainError("INVALID_STATE", "The objective is no longer open", 409);
    }
    return run.objective;
  }

  private async answerInvite(ctx: RequestContext, conversationId: string, action: MembershipAction, membership: MembershipState, reason: string) {
    this.requireAgent(ctx);
    await this.persistence.transaction(async (repos) => {
      const locked = await repos.autonomy.lockConversation(conversationId);
      if (!locked) {
        throw notFound("Conversation", conversationId);
      }
      if (locked.status !== "open") {
        throw new DomainError("INVALID_STATE", "The conversation is closed", 409);
      }
      const rows = await repos.autonomy.listMembership(conversationId);
      const mine = rows.find((item) => item.departmentId === ctx.actor.departmentId);
      if (!mine || mine.membership !== "invited") {
        throw new DomainError("AUTHORIZATION_DENIED", "This department has no open invitation", 403);
      }
      await this.seat(repos, ctx, {
        conversationId,
        departmentId: mine.departmentId,
        action,
        membership,
        reason,
        invitedByDepartmentId: mine.invitedByDepartmentId,
        joinedAt: membership === "active" ? this.now() : null,
        removedAt: null,
      });
    });
  }

  private async assertSeatAvailable(conversationId: string, departmentId: string) {
    const settings = await this.persistence.repos.autonomy.settings();
    const membership = await this.persistence.repos.autonomy.listMembership(conversationId);
    const existing = membership.find((item) => item.departmentId === departmentId);
    if (existing?.membership === "active") {
      throw new DomainError("INVALID_STATE", "That department is already participating", 409);
    }
    if (existing?.membership === "invited") {
      return;
    }
    const seated = membership.filter((item) => item.membership === "active" || item.membership === "invited").length;
    if (seated >= settings.maxConversationParticipants) {
      throw new DomainError("BUDGET_EXCEEDED", "The participant limit is already in use", 409);
    }
  }

  private async seat(
    repos: Repositories,
    ctx: RequestContext,
    input: {
      conversationId: string;
      departmentId: string;
      action: MembershipAction;
      membership: MembershipState;
      role?: ParticipantRole;
      reason: string;
      invitedByDepartmentId: string | null;
      joinedAt: Date | null;
      removedAt: Date | null;
    },
  ) {
    const existing = await repos.autonomy.listMembership(input.conversationId);
    const prior = existing.find((item) => item.departmentId === input.departmentId);
    const department = await repos.autonomy.department(input.departmentId);
    const joinSequence = prior && prior.joinSequence > 0
      ? prior.joinSequence
      : existing.reduce((max, item) => Math.max(max, item.joinSequence), 0) + 1;
    await repos.autonomy.upsertMembership({
      conversationId: input.conversationId,
      departmentId: input.departmentId,
      membership: input.membership,
      role: input.role ?? prior?.role ?? this.roleFor(department?.slug ?? "", "participant"),
      joinSequence,
      invitedByDepartmentId: input.invitedByDepartmentId,
      joinedAt: input.joinedAt,
      removedAt: input.removedAt,
    });
    await repos.autonomy.insertMembershipEvent({
      id: randomUUID(),
      conversationId: input.conversationId,
      departmentId: input.departmentId,
      action: input.action,
      actorDepartmentId: ctx.actor.departmentId,
      reason: input.reason,
    });
    await repos.audit.append({
      eventType: `conversation.${input.action}`,
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "conversation",
      targetId: input.conversationId,
      action: input.action,
      correlationId: ctx.correlationId,
      beforeState: null,
      afterState: { membership: input.membership, departmentId: input.departmentId },
      metadata: { departmentId: input.departmentId, reason: input.reason },
    });
  }

  private async finishClosed(
    repos: Repositories,
    id: string,
    status: ConversationRecord["status"],
    reason: string,
    actor: RequestContext,
  ) {
    const current = await repos.autonomy.findConversation(id);
    if (!current || current.status !== "open") {
      return;
    }
    const turns = await repos.autonomy.listTurns(id);
    const resolution = [...turns].reverse().find((turn) => turn.kind === "resolution");
    await repos.autonomy.saveConversation(id, {
      status,
      closeReason: reason,
      closedAt: this.now(),
      finalConclusion: resolution?.body ?? null,
      remainingDisagreements: turns
        .filter((turn) => turn.kind === "disagreement" || turn.kind === "counterargument" || turn.kind === "challenge")
        .slice(-8)
        .map((turn) => `${turn.departmentSlug}: ${turn.body}`),
      evidenceRefs: turns.filter((turn) => turn.kind === "evidence").map((turn) => turn.id),
      outcome: conversationOutcome(status, reason),
      runnerStatus: "stopped",
    });
    await repos.audit.append({
      eventType: "conversation.closed",
      actorId: actor.actor.principalId,
      actorType: actor.actor.principalType,
      targetType: "conversation",
      targetId: id,
      action: "close",
      correlationId: actor.correlationId,
      beforeState: { status: "open" },
      afterState: { status, closeReason: reason },
      metadata: { closeReason: reason },
    });
  }

  private systemContext(): RequestContext {
    return {
      correlationId: "autonomy-maintain",
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

  private groupRecipient(participants: string[], senderId: string, openerId: string): string {
    const others = participants.filter((id) => id !== senderId).sort();
    return others[0] ?? openerId;
  }

  private routed(provider: InferenceProvider, route: Route, department: { id: string; slug: string }) {
    const selected = selectConversationInference({
      departmentId: department.id,
      departmentSlug: department.slug,
      shared: provider,
      route,
    });
    logConversationInference(selected.metadata);
    return selected;
  }

  private async additionalParticipants(openerId: string, recipientId: string, ids: string[]) {
    if (new Set(ids).size !== ids.length || ids.includes(openerId) || ids.includes(recipientId)) {
      throw new DomainError("VALIDATION_ERROR", "Participant list contains a duplicate department", 422);
    }
    const departments = [];
    for (const id of ids) {
      departments.push(await this.requireConversationDepartment(id));
    }
    return departments;
  }

  private async requireConversationDepartment(id: string) {
    const department = await this.persistence.repos.autonomy.department(id);
    if (!department) {
      throw new DomainError("INVALID_REFERENCE", "Department was not found", 422);
    }
    if (department.status !== "active") {
      throw new DomainError("INVALID_STATE", "Department is not active", 409);
    }
    return this.requireAvailable(id);
  }

  private roleFor(slug: string, fallback: ParticipantRole): ParticipantRole {
    return slug === "evaluation" ? "evaluator" : fallback;
  }

  private async requireAvailable(id: string) {
    const department = await this.persistence.repos.autonomy.department(id);
    if (!department || department.status !== "active") {
      throw new DomainError("AUTHORIZATION_DENIED", "Dialogue requires an active department", 403);
    }
    const agent = await this.persistence.repos.autonomy.departmentAgent(id);
    if (!agent || !AVAILABLE.has(agent.status)) {
      throw new DomainError("AUTHORIZATION_DENIED", "The department agent is unavailable", 403);
    }
    return department;
  }

  private requireAgent(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "message:publish");
    if (!ctx.actor.agentId || !ctx.actor.departmentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Only a department agent can speak", 403);
    }
  }

  private requireKey(key: string) {
    if (!KEY.test(key)) {
      throw new DomainError("VALIDATION_ERROR", "Idempotency key is invalid", 422);
    }
  }

  private canModerate(ctx: RequestContext): boolean {
    return ROLE_PERMISSIONS[ctx.actor.role].has("autonomy:manage") || ROLE_PERMISSIONS[ctx.actor.role].has("message:admin");
  }

  private async requireParticipant(ctx: RequestContext, conversationId: string): Promise<ConversationRecord> {
    const conversation = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!conversation) {
      throw notFound("Conversation", conversationId);
    }
    const participants = await this.persistence.repos.autonomy.listParticipants(conversationId);
    if (!ctx.actor.departmentId || !participants.includes(ctx.actor.departmentId)) {
      throw new DomainError("AUTHORIZATION_DENIED", "This conversation is outside the caller's department", 403);
    }
    return conversation;
  }

  private async visibility(ctx: RequestContext, conversationId: string) {
    this.authorizer.assertAny(ctx.actor, ["message:read", "message:admin", "autonomy:manage"]);
    const conversation = await this.persistence.repos.autonomy.findConversation(conversationId);
    if (!conversation) {
      throw notFound("Conversation", conversationId);
    }
    if (this.canModerate(ctx)) {
      return { conversation, mode: "full" as const, removedAt: null };
    }
    const membership = await this.persistence.repos.autonomy.listMembership(conversationId);
    const mine = membership.find((item) => item.departmentId === ctx.actor.departmentId);
    if (!mine || mine.membership === "declined") {
      throw new DomainError("AUTHORIZATION_DENIED", "This conversation is outside the caller's department", 403);
    }
    if (mine.membership === "invited") {
      return { conversation, mode: "invited" as const, removedAt: null };
    }
    if (mine.membership === "removed") {
      return { conversation, mode: "removed" as const, removedAt: mine.removedAt };
    }
    return { conversation, mode: "full" as const, removedAt: null };
  }

  private closedError(reason: string | null): DomainError {
    if (reason === "loop") {
      return new DomainError("INVALID_STATE", "The conversation repeated the same turn and was closed", 409);
    }
    if (reason === "message_limit") {
      return new DomainError("BUDGET_EXCEEDED", "The conversation reached its message limit", 409);
    }
    if (reason === "token_limit") {
      return new DomainError("BUDGET_EXCEEDED", "The conversation reached its token limit", 409);
    }
    return new DomainError("INVALID_STATE", "The conversation is closed", 409);
  }
}

function conversationOutcome(status: string, reason: string): string {
  if (status === "resolved") {
    return "resolved";
  }
  if (reason === "message_limit" || reason === "token_limit") {
    return "budget_exhausted";
  }
  if (reason.startsWith("objective_")) {
    return "cancelled";
  }
  if (reason === "failed" || reason === "model_invalid") {
    return "failed";
  }
  if (reason.toLowerCase().includes("administrator")) {
    return "administratively_stopped";
  }
  return "unresolved";
}
