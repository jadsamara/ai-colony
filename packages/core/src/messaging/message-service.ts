import { randomUUID } from "node:crypto";
import {
  MAX_MESSAGE_PAYLOAD_BYTES,
  messageSchema,
  payloadSchemaByType,
  type Message,
  type MessagePublish,
  type MessageStatus,
  type MessageType,
} from "@ai-colony/contracts";
import { snapshot, type RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import { ROLE_PERMISSIONS } from "../governance/permissions.js";
import type {
  DeadLetterListFilter,
  MessageListFilter,
  Persistence,
  ProcessingRow,
} from "../ports/repositories.js";
import {
  assertRecipientAgentEligible,
  assertRecipientDepartmentEligible,
  assertSenderEligible,
  canDecideMessage,
  canReadMessage,
  crossDepartmentDeliveryAllowed,
} from "./access.js";
import { messageIdentityHash } from "./hash.js";
import { MessageHandlingError, recordReceipt, type MessageHandler } from "./handlers.js";
import { retryDelayMs, routingKeyFor, type MessagingPolicy } from "./policy.js";

const TERMINAL_PROCESSING = new Set([
  "recorded",
  "acknowledged",
  "rejected",
  "expired",
  "dead_lettered",
]);

export interface SendResult {
  message: Message;
  replayed: boolean;
}

export type DeliveryDisposition =
  "recorded" | "duplicate" | "expired" | "dead_lettered" | "retry_scheduled";

export type DeliveryOutcome =
  { action: "ack"; disposition: DeliveryDisposition } | { action: "requeue"; delayMs: number };

export class MessagingService {
  private readonly handler: MessageHandler;

  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly policy: MessagingPolicy,
    handler: MessageHandler = recordReceipt,
    private readonly random: () => number = Math.random,
  ) {
    this.handler = handler;
  }

  async send(ctx: RequestContext, input: MessagePublish): Promise<SendResult> {
    this.authorizer.assert(ctx.actor, "message:publish");
    if (!ctx.actor.agentId || !ctx.actor.departmentId) {
      throw new DomainError(
        "SENDER_NOT_AGENT",
        "Only an authenticated agent can publish a message",
        403,
      );
    }
    const payload = parsePayload(input.messageType, input.payload);
    assertPayloadSize(payload);
    const recipientAgentId = input.recipientAgentId ?? null;
    const recipientDepartmentId = input.recipientDepartmentId ?? null;
    const addressingMode = recipientAgentId ? "agent" : "department";
    const hash = messageIdentityHash({
      messageType: input.messageType,
      recipientAgentId,
      recipientDepartmentId,
      payload,
    });
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new DomainError(
        "MESSAGE_EXPIRED",
        "The message expiration is already in the past",
        409,
      );
    }

    return this.persistence.transaction(async (repos) => {
      if (input.idempotencyKey) {
        const existing = await repos.messages.findByIdempotency(
          ctx.actor.agentId ?? "",
          input.idempotencyKey,
        );
        if (existing) {
          if (existing.payloadHash !== hash) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "This idempotency key was already used for a different message",
              409,
            );
          }
          return { message: existing.message, replayed: true };
        }
      }

      const sender = await repos.agents.lockById(ctx.actor.agentId ?? "");
      if (!sender) {
        throw notFound("Agent", ctx.actor.agentId ?? "");
      }
      const senderDepartment = await repos.departments.lockById(sender.departmentId);
      if (!senderDepartment) {
        throw notFound("Department", sender.departmentId);
      }
      assertSenderEligible(sender.status, senderDepartment, sender.departmentId);

      let inboxDepartmentId: string;
      if (addressingMode === "agent") {
        const recipient = await repos.agents.lockById(recipientAgentId ?? "");
        if (!recipient) {
          throw notFound("Agent", recipientAgentId ?? "");
        }
        const department = await repos.departments.lockById(recipient.departmentId);
        if (!department) {
          throw notFound("Department", recipient.departmentId);
        }
        assertRecipientAgentEligible(recipient.status, department);
        if (!crossDepartmentDeliveryAllowed(sender.departmentId, department.id)) {
          throw new DomainError(
            "CROSS_DEPARTMENT_DENIED",
            "Cross-department delivery is denied",
            403,
          );
        }
        inboxDepartmentId = department.id;
      } else {
        const department = await repos.departments.lockById(recipientDepartmentId ?? "");
        if (!department) {
          throw notFound("Department", recipientDepartmentId ?? "");
        }
        assertRecipientDepartmentEligible(department);
        if (!crossDepartmentDeliveryAllowed(sender.departmentId, department.id)) {
          throw new DomainError(
            "CROSS_DEPARTMENT_DENIED",
            "Cross-department delivery is denied",
            403,
          );
        }
        inboxDepartmentId = department.id;
      }

      await this.assertPayloadReferences(repos, input.messageType, payload);
      let correlationId = input.correlationId ?? randomUUID();
      if (input.replyToMessageId) {
        const prior = await repos.messages.findById(input.replyToMessageId);
        if (!prior || !canReadMessage(ctx.actor, prior.message)) {
          throw notFound("Message", input.replyToMessageId);
        }
        if (!input.correlationId) {
          correlationId = prior.message.correlationId;
        }
      }
      if (input.causationId) {
        const cause = await repos.messages.findById(input.causationId);
        if (!cause || !canReadMessage(ctx.actor, cause.message)) {
          throw notFound("Message", input.causationId);
        }
      }

      const stored = await repos.messages.insertAccepted({
        id: randomUUID(),
        messageType: input.messageType,
        senderAgentId: sender.id,
        senderDepartmentId: sender.departmentId,
        recipientAgentId,
        recipientDepartmentId: addressingMode === "department" ? recipientDepartmentId : null,
        addressingMode,
        inboxDepartmentId,
        correlationId,
        causationId: input.causationId ?? null,
        replyToMessageId: input.replyToMessageId ?? null,
        priority: input.priority,
        payload,
        payloadHash: hash,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: input.metadata ?? {},
        expiresAt,
      });
      await repos.audit.append({
        eventType: "message.accepted",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "message",
        targetId: stored.message.messageId,
        action: "message.accepted",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: messageAuditState(stored.message),
        metadata: { messageType: stored.message.messageType, payloadHash: hash },
      });
      return { message: stored.message, replayed: false };
    });
  }

  requestTask(ctx: RequestContext, input: MessagePublish): Promise<SendResult> {
    return this.send(ctx, { ...input, messageType: "TASK_REQUEST" });
  }

  publishKnowledge(ctx: RequestContext, input: MessagePublish): Promise<SendResult> {
    return this.send(ctx, { ...input, messageType: "KNOWLEDGE_SHARE" });
  }

  requestCollaboration(ctx: RequestContext, input: MessagePublish): Promise<SendResult> {
    return this.send(ctx, { ...input, messageType: "COLLABORATION_REQUEST" });
  }

  async get(ctx: RequestContext, messageId: string): Promise<Message> {
    this.assertRead(ctx);
    const stored = await this.persistence.repos.messages.findById(messageId);
    if (!stored || !canReadMessage(ctx.actor, stored.message)) {
      throw notFound("Message", messageId);
    }
    return stored.message;
  }

  async list(ctx: RequestContext, filter: Omit<MessageListFilter, "visibility">) {
    this.assertRead(ctx);
    if (filter.inbox) {
      this.authorizer.assert(ctx.actor, "message:consume");
    }
    return this.persistence.repos.messages.list({
      ...filter,
      visibility: visibilityFor(ctx),
    });
  }

  receiveMessage(ctx: RequestContext, filter: Omit<MessageListFilter, "visibility" | "inbox">) {
    this.authorizer.assert(ctx.actor, "message:consume");
    return this.list(ctx, { ...filter, inbox: "agent" });
  }

  async getConversationHistory(
    ctx: RequestContext,
    correlationId: string,
    filter: Omit<MessageListFilter, "visibility" | "correlationId">,
  ) {
    const page = await this.list(ctx, { ...filter, correlationId });
    if (page.data.length === 0 && !filter.cursor) {
      throw notFound("Conversation", correlationId);
    }
    return page;
  }

  async getStatus(ctx: RequestContext, messageId: string) {
    const message = await this.get(ctx, messageId);
    const [outbox, processing, deadLetter] = await Promise.all([
      this.persistence.repos.messages.listOutbox(messageId),
      this.persistence.repos.messages.getProcessing(messageId),
      this.persistence.repos.messages.findOpenDeadLetter(messageId),
    ]);
    return {
      message,
      outbox: outbox.map((row) => ({
        outboxId: row.outboxId,
        attempt: row.attempt,
        status: row.status,
        publishAttempts: row.publishAttempts,
        availableAt: row.availableAt,
        publishedAt: row.publishedAt,
        lastError: row.lastError,
      })),
      processing: processing
        ? {
            status: processing.status,
            attemptCount: processing.attemptCount,
            lastError: processing.lastError,
            completedAt: processing.completedAt,
          }
        : null,
      deadLetter,
    };
  }

  async acknowledge(ctx: RequestContext, messageId: string): Promise<Message> {
    return this.decide(ctx, messageId, "acknowledged");
  }

  async reject(ctx: RequestContext, messageId: string, reason: string): Promise<Message> {
    return this.decide(ctx, messageId, "rejected", reason);
  }

  async listDeadLetters(ctx: RequestContext, filter: Omit<DeadLetterListFilter, "visibility">) {
    this.authorizer.assert(ctx.actor, "message:dead_letter:read");
    return this.persistence.repos.messages.listDeadLetters({
      ...filter,
      visibility: visibilityFor(ctx),
    });
  }

  async redrive(ctx: RequestContext, deadLetterId: string) {
    this.authorizer.assert(ctx.actor, "message:dead_letter:redrive");
    return this.persistence.transaction(async (repos) => {
      const deadLetter = await repos.messages.findDeadLetter(deadLetterId);
      if (!deadLetter || deadLetter.status !== "open" || !deadLetter.messageId) {
        throw notFound("DeadLetter", deadLetterId);
      }
      const stored = await repos.messages.lockById(deadLetter.messageId);
      if (!stored) {
        throw notFound("Message", deadLetter.messageId);
      }
      const attempt = await repos.messages.nextOutboxAttempt(stored.message.messageId);
      await repos.messages.updateStatus(stored.message.messageId, "accepted");
      const processing = await repos.messages.getProcessing(stored.message.messageId);
      if (!processing) {
        await repos.messages.insertProcessing({
          messageId: stored.message.messageId,
          owner: "redrive",
          leaseUntil: new Date(),
        });
      }
      await repos.messages.updateProcessing(stored.message.messageId, {
        status: "retry_scheduled",
        owner: null,
        leaseUntil: null,
        lastError: null,
        completedAt: null,
      });
      await repos.messages.insertOutbox(stored.message.messageId, attempt, new Date());
      const redriven = await repos.messages.markDeadLetterRedriven(
        deadLetterId,
        ctx.actor.principalId,
      );
      const updated = await repos.messages.findById(stored.message.messageId);
      if (!updated) {
        throw notFound("Message", stored.message.messageId);
      }
      await repos.audit.append({
        eventType: "message.redriven",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "message",
        targetId: updated.message.messageId,
        action: "message.redriven",
        correlationId: ctx.correlationId,
        beforeState: messageAuditState(stored.message),
        afterState: messageAuditState(updated.message),
        metadata: { deadLetterId, reason: deadLetter.reason },
      });
      return { deadLetter: redriven, message: updated.message };
    });
  }

  async touchLease(messageId: string, workerId: string): Promise<void> {
    await this.persistence.repos.messages.touchProcessingLease(
      messageId,
      workerId,
      new Date(Date.now() + this.policy.leaseMs),
    );
  }

  metrics(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "message:admin");
    return this.persistence.repos.messages.metrics();
  }

  async processInbound(input: {
    workerId: string;
    routingKey: string;
    body: unknown;
  }): Promise<DeliveryOutcome> {
    const parsed = parseWire(input.body);
    if (!parsed.ok) {
      try {
        await this.persistence.repos.messages.insertDeadLetter({
          id: randomUUID(),
          messageId: null,
          reason: "invalid_envelope",
          detail: parsed.detail,
          attemptCount: 0,
        });
        return { action: "ack", disposition: "dead_lettered" };
      } catch {
        return { action: "requeue", delayMs: this.delay(1) };
      }
    }

    try {
      return await this.persistence
        .transaction(async (repos) => {
          const stored = await repos.messages.lockById(parsed.messageId);
          if (!stored) {
            await repos.messages.insertDeadLetter({
              id: randomUUID(),
              messageId: null,
              reason: "unknown_message",
              detail: parsed.messageId,
              attemptCount: 0,
            });
            return { action: "ack", disposition: "dead_lettered" } as const;
          }
          const message = stored.message;
          if (
            stored.payloadHash !== parsed.payloadHash ||
            !routingMatches(message, input.routingKey)
          ) {
            await this.deadLetter(
              repos,
              message,
              "payload_or_routing_mismatch",
              input.routingKey,
              0,
              input.workerId,
            );
            return { action: "ack", disposition: "dead_lettered" } as const;
          }
          if (message.expiresAt && new Date(message.expiresAt).getTime() <= Date.now()) {
            await this.deadLetter(
              repos,
              message,
              "expired",
              "Message expired before handling",
              0,
              input.workerId,
            );
            await repos.messages.updateStatus(message.messageId, "expired");
            return { action: "ack", disposition: "expired" } as const;
          }
          if (message.status === "expired" || message.status === "dead_lettered") {
            await repos.messages.insertDeliveryAttempt({
              messageId: message.messageId,
              attempt: 0,
              outcome: "duplicate",
              error: null,
              workerId: input.workerId,
            });
            return { action: "ack", disposition: "duplicate" } as const;
          }

          const owned = await this.acquire(repos, message.messageId, input.workerId);
          if (!owned) {
            await repos.messages.insertDeliveryAttempt({
              messageId: message.messageId,
              attempt: 0,
              outcome: "duplicate",
              error: null,
              workerId: input.workerId,
            });
            return { action: "ack", disposition: "duplicate" } as const;
          }
          return { action: "continue", message } as const;
        })
        .then(async (result) => {
          if (result.action !== "continue") {
            return result;
          }
          try {
            await this.handler(result.message);
          } catch (error) {
            const permanent = error instanceof MessageHandlingError && error.permanent;
            return this.failHandler(result.message, input.workerId, errorText(error), permanent);
          }
          try {
            await this.persistence.transaction(async (repos) => {
              await repos.messages.updateProcessing(result.message.messageId, {
                status: "recorded",
                owner: input.workerId,
                leaseUntil: null,
                lastError: null,
                completedAt: new Date(),
              });
              if (result.message.status === "accepted" || result.message.status === "published") {
                await repos.messages.updateStatus(result.message.messageId, "delivered");
              }
              const processing = await repos.messages.getProcessing(result.message.messageId);
              await repos.messages.insertDeliveryAttempt({
                messageId: result.message.messageId,
                attempt: processing?.attemptCount ?? 1,
                outcome: "recorded",
                error: null,
                workerId: input.workerId,
              });
            });
          } catch {
            await this.releaseProcessing(result.message.messageId);
            return { action: "requeue", delayMs: this.delay(1) };
          }
          return { action: "ack", disposition: "recorded" } as const;
        });
    } catch {
      return { action: "requeue", delayMs: this.delay(1) };
    }
  }

  private async failHandler(
    message: Message,
    workerId: string,
    error: string,
    permanent: boolean,
  ): Promise<DeliveryOutcome> {
    return this.persistence.transaction(async (repos) => {
      const processing = await repos.messages.lockProcessing(message.messageId);
      const attempt = (processing?.attemptCount ?? 0) + 1;
      if (permanent || attempt >= this.policy.maxHandlerAttempts) {
        await this.deadLetter(
          repos,
          message,
          permanent ? "permanent_handler_failure" : "retries_exhausted",
          error,
          attempt,
          workerId,
        );
        return { action: "ack", disposition: "dead_lettered" } as const;
      }
      const availableAt = new Date(Date.now() + this.delay(attempt));
      const outboxAttempt = await repos.messages.nextOutboxAttempt(message.messageId);
      await repos.messages.updateProcessing(message.messageId, {
        status: "retry_scheduled",
        attemptCount: attempt,
        owner: null,
        leaseUntil: null,
        lastError: error,
        completedAt: null,
      });
      await repos.messages.insertOutbox(message.messageId, outboxAttempt, availableAt);
      await repos.messages.insertDeliveryAttempt({
        messageId: message.messageId,
        attempt,
        outcome: "retry_scheduled",
        error,
        workerId,
      });
      return { action: "ack", disposition: "retry_scheduled" } as const;
    });
  }

  private async acquire(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    messageId: string,
    workerId: string,
  ): Promise<boolean> {
    const existing = await repos.messages.lockProcessing(messageId);
    const leaseUntil = new Date(Date.now() + this.policy.leaseMs);
    if (!existing) {
      await repos.messages.insertProcessing({ messageId, owner: workerId, leaseUntil });
      return true;
    }
    if (TERMINAL_PROCESSING.has(existing.status)) {
      return false;
    }
    const leaseActive =
      existing.status === "processing" &&
      existing.leaseUntil !== null &&
      new Date(existing.leaseUntil).getTime() > Date.now() &&
      existing.owner !== workerId;
    if (leaseActive) {
      return false;
    }
    await repos.messages.updateProcessing(messageId, {
      status: "processing",
      owner: workerId,
      leaseUntil,
      lastError: existing.lastError,
    });
    return true;
  }

  private async deadLetter(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    message: Message,
    reason: string,
    detail: string,
    attemptCount: number,
    workerId: string,
  ): Promise<void> {
    const open = await repos.messages.findOpenDeadLetter(message.messageId);
    if (!open) {
      await repos.messages.insertDeadLetter({
        id: randomUUID(),
        messageId: message.messageId,
        reason,
        detail: detail.slice(0, 2000),
        attemptCount,
      });
    }
    const processing = await repos.messages.lockProcessing(message.messageId);
    if (processing) {
      await repos.messages.updateProcessing(message.messageId, {
        status: reason === "expired" ? "expired" : "dead_lettered",
        attemptCount,
        owner: null,
        leaseUntil: null,
        lastError: detail.slice(0, 2000),
        completedAt: new Date(),
      });
    } else if (reason !== "payload_or_routing_mismatch") {
      await repos.messages.insertProcessing({
        messageId: message.messageId,
        owner: workerId,
        leaseUntil: new Date(),
      });
      await repos.messages.updateProcessing(message.messageId, {
        status: reason === "expired" ? "expired" : "dead_lettered",
        attemptCount,
        owner: null,
        leaseUntil: null,
        lastError: detail.slice(0, 2000),
        completedAt: new Date(),
      });
    }
    if (message.status !== "acknowledged" && message.status !== "rejected") {
      await repos.messages.updateStatus(
        message.messageId,
        reason === "expired" ? "expired" : "dead_lettered",
      );
    }
    await repos.messages.insertDeliveryAttempt({
      messageId: message.messageId,
      attempt: attemptCount,
      outcome: reason === "expired" ? "expired" : "dead_lettered",
      error: detail.slice(0, 2000),
      workerId,
    });
    await repos.audit.append({
      eventType: reason === "expired" ? "message.expired" : "message.dead_lettered",
      actorId: "system:messaging-consumer",
      actorType: "system",
      targetType: "message",
      targetId: message.messageId,
      action: reason === "expired" ? "message.expired" : "message.dead_lettered",
      correlationId: message.correlationId,
      beforeState: messageAuditState(message),
      afterState: null,
      metadata: { reason, attemptCount },
    });
  }

  private async decide(
    ctx: RequestContext,
    messageId: string,
    status: Extract<MessageStatus, "acknowledged" | "rejected">,
    reason?: string,
  ): Promise<Message> {
    this.authorizer.assert(ctx.actor, "message:acknowledge");
    return this.persistence.transaction(async (repos) => {
      const stored = await repos.messages.lockById(messageId);
      if (!stored || !canReadMessage(ctx.actor, stored.message)) {
        throw notFound("Message", messageId);
      }
      if (!canDecideMessage(ctx.actor, stored.message)) {
        throw new DomainError(
          "AUTHORIZATION_DENIED",
          "Only the addressed recipient can acknowledge or reject this message",
          403,
        );
      }
      if (stored.message.status !== "delivered") {
        throw new DomainError(
          "MESSAGE_NOT_DELIVERED",
          "The message has not been durably delivered to the inbox",
          409,
          { status: stored.message.status },
        );
      }
      const updated = await repos.messages.updateStatus(messageId, status);
      await repos.messages.updateProcessing(messageId, {
        status,
        lastError: reason ?? null,
        completedAt: new Date(),
      });
      await repos.audit.append({
        eventType: status === "acknowledged" ? "message.acknowledged" : "message.rejected",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "message",
        targetId: messageId,
        action: status === "acknowledged" ? "message.acknowledged" : "message.rejected",
        correlationId: ctx.correlationId,
        beforeState: messageAuditState(stored.message),
        afterState: messageAuditState(updated.message),
        metadata: reason ? { reason } : {},
      });
      return updated.message;
    });
  }

  private assertRead(ctx: RequestContext): void {
    const granted = ROLE_PERMISSIONS[ctx.actor.role];
    if (!granted.has("message:read") && !granted.has("message:admin")) {
      throw new DomainError("AUTHORIZATION_DENIED", "Missing permission message:read", 403, {
        permission: "message:read",
        role: ctx.actor.role,
      });
    }
  }

  private async releaseProcessing(messageId: string): Promise<void> {
    await this.persistence.repos.messages
      .updateProcessing(messageId, {
        status: "retry_scheduled",
        owner: null,
        leaseUntil: null,
      })
      .catch(() => undefined);
  }

  private delay(attempt: number): number {
    return retryDelayMs(attempt, this.policy.retryBaseMs, this.policy.retryMaxDelayMs, this.random);
  }

  private async assertPayloadReferences(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    messageType: MessageType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (messageType === "TRAINING_REQUEST" || messageType === "MODEL_CANDIDATE") {
      const modelId = String(payload.targetModelId ?? payload.modelId ?? "");
      const model = await repos.models.findById(modelId);
      if (!model) {
        throw notFound("Model", modelId);
      }
    }
    if (messageType === "EVOLUTION_PROPOSAL") {
      const ids = payload.affectedDepartments;
      if (!Array.isArray(ids)) {
        return;
      }
      for (const id of ids) {
        if (typeof id !== "string") {
          continue;
        }
        const department = await repos.departments.findById(id);
        if (!department) {
          throw notFound("Department", id);
        }
      }
    }
  }
}

function visibilityFor(ctx: RequestContext) {
  return {
    unrestricted: ROLE_PERMISSIONS[ctx.actor.role].has("message:admin"),
    agentId: ctx.actor.agentId,
    departmentId: ctx.actor.departmentId,
  };
}

function parsePayload(messageType: MessageType, payload: unknown): Record<string, unknown> {
  const parsed: unknown = payloadSchemaByType[messageType].parse(payload);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("VALIDATION_ERROR", "Payload must be an object", 400);
  }
  return parsed as Record<string, unknown>;
}

function assertPayloadSize(payload: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > MAX_MESSAGE_PAYLOAD_BYTES) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "Message payload exceeds 64KiB", 413);
  }
}

function messageAuditState(message: Message): Record<string, unknown> | null {
  return snapshot({
    messageId: message.messageId,
    messageType: message.messageType,
    status: message.status,
    senderAgentId: message.senderAgentId,
    recipientAgentId: message.recipientAgentId,
    recipientDepartmentId: message.recipientDepartmentId,
    correlationId: message.correlationId,
  });
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "Handler failed";
  return message.slice(0, 2000);
}

function routingMatches(message: Message, routingKey: string): boolean {
  return routingKeyFor(message) === routingKey;
}

function parseWire(
  body: unknown,
): { ok: true; messageId: string; payloadHash: string } | { ok: false; detail: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, detail: "Envelope is not an object" };
  }
  const record = body as Record<string, unknown>;
  const parsed = messageSchema.safeParse(record);
  if (!parsed.success) {
    return { ok: false, detail: "Envelope failed protocol validation" };
  }
  return {
    ok: true,
    messageId: parsed.data.messageId,
    payloadHash: messageIdentityHash({
      messageType: parsed.data.messageType,
      recipientAgentId: parsed.data.recipientAgentId,
      recipientDepartmentId: parsed.data.recipientDepartmentId,
      payload: parsed.data.payload,
    }),
  };
}

export function isTerminalProcessing(row: ProcessingRow | null): boolean {
  return row !== null && TERMINAL_PROCESSING.has(row.status);
}
