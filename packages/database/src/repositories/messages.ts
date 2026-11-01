import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, max, ne, or, sql, type SQL } from "drizzle-orm";
import { deadLetterSchema, messageSchema, messagingMetricsSchema } from "@ai-colony/contracts";
import {
  buildPage,
  notFound,
  type MessageListFilter,
  type MessageRepository,
  type MessageVisibility,
  type OutboxRow,
  type ProcessingRow,
  type ProcessingStatus,
  type StoredMessage,
} from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import { guard } from "../db-error.js";
import {
  agents,
  departments,
  iacpMessages,
  messageDeadLetters,
  messageDeliveryAttempts,
  messageOutbox,
  messageProcessingRecords,
} from "../schema/index.js";

type MessageRow = typeof iacpMessages.$inferSelect;
type OutboxDbRow = typeof messageOutbox.$inferSelect;
type ProcessingDbRow = typeof messageProcessingRecords.$inferSelect;
type DeadLetterRow = typeof messageDeadLetters.$inferSelect;

export function createMessageRepository(db: DbExecutor): MessageRepository {
  return {
    async insertAccepted(input) {
      return guard(async () => {
        const [row] = await db
          .insert(iacpMessages)
          .values({
            id: input.id,
            protocolVersion: "1.0",
            messageType: input.messageType,
            senderAgentId: input.senderAgentId,
            senderDepartmentId: input.senderDepartmentId,
            recipientAgentId: input.recipientAgentId,
            recipientDepartmentId: input.recipientDepartmentId,
            addressingMode: input.addressingMode,
            inboxDepartmentId: input.inboxDepartmentId,
            correlationId: input.correlationId,
            causationId: input.causationId,
            replyToMessageId: input.replyToMessageId,
            priority: input.priority,
            payload: input.payload,
            payloadSchemaVersion: "1.0",
            payloadHash: input.payloadHash,
            idempotencyKey: input.idempotencyKey,
            metadata: input.metadata,
            status: "accepted",
            expiresAt: input.expiresAt,
          })
          .returning();
        if (!row) {
          throw new Error("Message insert did not return a row");
        }
        await db.insert(messageOutbox).values({
          id: randomUUID(),
          messageId: row.id,
          attempt: 1,
          status: "pending",
          availableAt: new Date(),
          publishAttempts: 0,
        });
        return mapStored(row);
      });
    },
    findById(id) {
      return loadMessage(db, id, false);
    },
    lockById(id) {
      return loadMessage(db, id, true);
    },
    async findByIdempotency(senderAgentId, key) {
      const [row] = await db
        .select()
        .from(iacpMessages)
        .where(
          and(eq(iacpMessages.senderAgentId, senderAgentId), eq(iacpMessages.idempotencyKey, key)),
        )
        .limit(1);
      return row ? mapStored(row) : null;
    },
    async list(filter) {
      const filters = [
        visibilityClause(filter.visibility),
        inboxClause(filter),
        filter.messageType ? eq(iacpMessages.messageType, filter.messageType) : undefined,
        filter.status ? eq(iacpMessages.status, filter.status) : undefined,
        filter.correlationId ? eq(iacpMessages.correlationId, filter.correlationId) : undefined,
        filter.cursor
          ? or(
              sql`${iacpMessages.createdAt} < ${filter.cursor.createdAt}`,
              and(
                eq(iacpMessages.createdAt, filter.cursor.createdAt),
                sql`${iacpMessages.id} < ${filter.cursor.id}`,
              ),
            )
          : undefined,
      ].filter((item): item is SQL => item !== undefined);
      const rows = await db
        .select()
        .from(iacpMessages)
        .where(and(...filters))
        .orderBy(desc(iacpMessages.createdAt), desc(iacpMessages.id))
        .limit(filter.limit + 1);
      return buildPage(
        rows.map((row) => mapStored(row).message),
        filter.limit,
        (message) => ({ createdAt: message.createdAt, id: message.messageId }),
      );
    },
    async updateStatus(id, status) {
      const [row] = await db
        .update(iacpMessages)
        .set({ status, updatedAt: new Date() })
        .where(eq(iacpMessages.id, id))
        .returning();
      if (!row) {
        throw notFound("Message", id);
      }
      return mapStored(row);
    },
    async claimOutbox(workerId, limit, leaseMs) {
      const claimed = await db.execute<{ id: string }>(sql`
        WITH picked AS (
          SELECT o.id
          FROM message_outbox o
          INNER JOIN messages m ON m.id = o.message_id
          WHERE (o.status = 'pending' AND o.available_at <= now())
             OR (o.status = 'publishing' AND o.lease_until <= now())
          ORDER BY m.priority DESC, o.available_at ASC, o.id ASC
          FOR UPDATE OF o SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE message_outbox AS o
        SET status = 'publishing',
            claimed_by = ${workerId},
            claimed_at = now(),
            lease_until = now() + (${leaseMs} * interval '1 millisecond'),
            publish_attempts = o.publish_attempts + 1,
            updated_at = now()
        FROM picked
        WHERE o.id = picked.id
        RETURNING o.id
      `);
      const ids = [...claimed]
        .map((row) => row.id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length === 0) {
        return [];
      }
      const rows = await db
        .select({ outbox: messageOutbox, message: iacpMessages })
        .from(messageOutbox)
        .innerJoin(iacpMessages, eq(iacpMessages.id, messageOutbox.messageId))
        .where(inArray(messageOutbox.id, ids));
      return rows.map((row) => ({
        ...mapOutbox(row.outbox),
        message: mapStored(row.message).message,
      }));
    },
    async markPublished(outboxId, workerId) {
      const [row] = await db
        .update(messageOutbox)
        .set({
          status: "published",
          publishedAt: new Date(),
          leaseUntil: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(messageOutbox.id, outboxId),
            eq(messageOutbox.claimedBy, workerId),
            eq(messageOutbox.status, "publishing"),
          ),
        )
        .returning();
      if (!row) {
        return;
      }
      await db
        .update(iacpMessages)
        .set({ status: "published", updatedAt: new Date() })
        .where(and(eq(iacpMessages.id, row.messageId), eq(iacpMessages.status, "accepted")));
    },
    async schedulePublishRetry(input) {
      const [row] = await db
        .update(messageOutbox)
        .set({
          status: input.fail ? "failed" : "pending",
          availableAt: input.availableAt,
          leaseUntil: null,
          lastError: input.error.slice(0, 2000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(messageOutbox.id, input.outboxId),
            eq(messageOutbox.claimedBy, input.workerId),
            eq(messageOutbox.status, "publishing"),
          ),
        )
        .returning();
      if (!row || !input.fail) {
        return;
      }
      await db
        .update(iacpMessages)
        .set({ status: "dead_lettered", updatedAt: new Date() })
        .where(
          and(
            eq(iacpMessages.id, row.messageId),
            inArray(iacpMessages.status, ["accepted", "published"]),
          ),
        );
      const [open] = await db
        .select({ id: messageDeadLetters.id })
        .from(messageDeadLetters)
        .where(
          and(
            eq(messageDeadLetters.messageId, row.messageId),
            eq(messageDeadLetters.status, "open"),
          ),
        )
        .limit(1);
      if (!open) {
        await db.insert(messageDeadLetters).values({
          id: randomUUID(),
          messageId: row.messageId,
          reason: "publish_exhausted",
          detail: input.error.slice(0, 2000),
          attemptCount: row.publishAttempts,
          status: "open",
        });
      }
    },
    async insertOutbox(messageId, attempt, availableAt) {
      await db.insert(messageOutbox).values({
        id: randomUUID(),
        messageId,
        attempt,
        status: "pending",
        availableAt,
        publishAttempts: 0,
      });
    },
    async nextOutboxAttempt(messageId) {
      const [row] = await db
        .select({ value: max(messageOutbox.attempt) })
        .from(messageOutbox)
        .where(eq(messageOutbox.messageId, messageId));
      return (row?.value ?? 0) + 1;
    },
    async listOutbox(messageId) {
      const rows = await db
        .select()
        .from(messageOutbox)
        .where(eq(messageOutbox.messageId, messageId))
        .orderBy(asc(messageOutbox.attempt));
      return rows.map(mapOutbox);
    },
    async lockProcessing(messageId) {
      const [row] = await db
        .select()
        .from(messageProcessingRecords)
        .where(eq(messageProcessingRecords.messageId, messageId))
        .for("update")
        .limit(1);
      return row ? mapProcessing(row) : null;
    },
    async insertProcessing(input) {
      await db.insert(messageProcessingRecords).values({
        messageId: input.messageId,
        status: "processing",
        attemptCount: 0,
        owner: input.owner,
        leaseUntil: input.leaseUntil,
      });
    },
    async updateProcessing(messageId, patch) {
      const [row] = await db
        .update(messageProcessingRecords)
        .set({
          status: patch.status,
          updatedAt: new Date(),
          ...(patch.attemptCount !== undefined ? { attemptCount: patch.attemptCount } : {}),
          ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
          ...(patch.leaseUntil !== undefined ? { leaseUntil: patch.leaseUntil } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        })
        .where(eq(messageProcessingRecords.messageId, messageId))
        .returning();
      if (!row) {
        throw notFound("ProcessingRecord", messageId);
      }
    },
    async insertDeliveryAttempt(input) {
      await db.insert(messageDeliveryAttempts).values({
        messageId: input.messageId,
        attempt: input.attempt,
        outcome: input.outcome,
        error: input.error,
        workerId: input.workerId,
      });
    },
    async insertDeadLetter(input) {
      const [row] = await db
        .insert(messageDeadLetters)
        .values({
          id: input.id,
          messageId: input.messageId,
          reason: input.reason,
          detail: input.detail.slice(0, 2000),
          attemptCount: input.attemptCount,
          status: "open",
        })
        .returning();
      if (!row) {
        throw new Error("Dead letter insert did not return a row");
      }
      return mapDeadLetter(row, null);
    },
    async findDeadLetter(id) {
      const [row] = await db
        .select({ dead: messageDeadLetters, message: iacpMessages })
        .from(messageDeadLetters)
        .leftJoin(iacpMessages, eq(iacpMessages.id, messageDeadLetters.messageId))
        .where(eq(messageDeadLetters.id, id))
        .limit(1);
      return row ? mapDeadLetter(row.dead, row.message?.messageType ?? null) : null;
    },
    async findOpenDeadLetter(messageId) {
      const [row] = await db
        .select({ dead: messageDeadLetters, message: iacpMessages })
        .from(messageDeadLetters)
        .leftJoin(iacpMessages, eq(iacpMessages.id, messageDeadLetters.messageId))
        .where(
          and(eq(messageDeadLetters.messageId, messageId), eq(messageDeadLetters.status, "open")),
        )
        .limit(1);
      return row ? mapDeadLetter(row.dead, row.message?.messageType ?? null) : null;
    },
    async listDeadLetters(filter) {
      const filters = [
        deadLetterVisibility(filter.visibility),
        filter.status ? eq(messageDeadLetters.status, filter.status) : undefined,
        filter.cursor
          ? or(
              sql`${messageDeadLetters.createdAt} < ${filter.cursor.createdAt}`,
              and(
                eq(messageDeadLetters.createdAt, filter.cursor.createdAt),
                sql`${messageDeadLetters.id} < ${filter.cursor.id}`,
              ),
            )
          : undefined,
      ].filter((item): item is SQL => item !== undefined);
      const rows = await db
        .select({ dead: messageDeadLetters, message: iacpMessages })
        .from(messageDeadLetters)
        .leftJoin(iacpMessages, eq(iacpMessages.id, messageDeadLetters.messageId))
        .where(and(...filters))
        .orderBy(desc(messageDeadLetters.createdAt), desc(messageDeadLetters.id))
        .limit(filter.limit + 1);
      return buildPage(
        rows.map((row) => mapDeadLetter(row.dead, row.message?.messageType ?? null)),
        filter.limit,
        (letter) => ({ createdAt: letter.createdAt, id: letter.deadLetterId }),
      );
    },
    async markDeadLetterRedriven(id, actorId) {
      const [row] = await db
        .update(messageDeadLetters)
        .set({
          status: "redriven",
          redrivenAt: new Date(),
          redrivenBy: actorId,
          updatedAt: new Date(),
        })
        .where(and(eq(messageDeadLetters.id, id), eq(messageDeadLetters.status, "open")))
        .returning();
      if (!row) {
        throw notFound("DeadLetter", id);
      }
      const messageType = row.messageId ? await messageTypeOf(db, row.messageId) : null;
      return mapDeadLetter(row, messageType);
    },
    async getProcessing(messageId) {
      const [row] = await db
        .select()
        .from(messageProcessingRecords)
        .where(eq(messageProcessingRecords.messageId, messageId))
        .limit(1);
      return row ? mapProcessing(row) : null;
    },
    async metrics() {
      const [
        pending,
        publishing,
        published,
        failed,
        recorded,
        retryScheduled,
        deadLettered,
        dead,
        oldest,
      ] = await Promise.all([
        countWhere(db, messageOutbox, eq(messageOutbox.status, "pending")),
        countWhere(db, messageOutbox, eq(messageOutbox.status, "publishing")),
        countWhere(db, messageOutbox, eq(messageOutbox.status, "published")),
        countWhere(db, messageOutbox, eq(messageOutbox.status, "failed")),
        countWhere(db, messageProcessingRecords, eq(messageProcessingRecords.status, "recorded")),
        countWhere(
          db,
          messageProcessingRecords,
          eq(messageProcessingRecords.status, "retry_scheduled"),
        ),
        countWhere(
          db,
          messageProcessingRecords,
          eq(messageProcessingRecords.status, "dead_lettered"),
        ),
        countWhere(db, messageDeadLetters, eq(messageDeadLetters.status, "open")),
        db
          .select({
            age: sql<
              number | null
            >`(extract(epoch from (now() - min(${messageOutbox.availableAt}))) * 1000)::int`,
          })
          .from(messageOutbox)
          .where(eq(messageOutbox.status, "pending")),
      ]);
      return messagingMetricsSchema.parse({
        outbox: { pending, publishing, published, failed },
        processing: { recorded, retryScheduled, deadLettered },
        deadLettersOpen: dead,
        oldestPendingAgeMs:
          oldest[0]?.age === null || oldest[0]?.age === undefined ? null : Number(oldest[0].age),
        deliveryGuarantee: "at-least-once",
      });
    },
    async listActiveRouting() {
      const departmentRows = await db
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.status, "active"));
      const activeIds = new Set(departmentRows.map((row) => row.id));
      const agentRows = await db
        .select({ id: agents.id, departmentId: agents.departmentId })
        .from(agents)
        .where(ne(agents.status, "archived"));
      const grouped = new Map<string, string[]>();
      for (const departmentId of activeIds) {
        grouped.set(departmentId, []);
      }
      for (const agent of agentRows) {
        if (!activeIds.has(agent.departmentId)) {
          continue;
        }
        grouped.get(agent.departmentId)?.push(agent.id);
      }
      return [...grouped.entries()].map(([departmentId, agentIds]) => ({ departmentId, agentIds }));
    },
    async listArchivedDepartments() {
      const rows = await db
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.status, "archived"));
      return rows.map((row) => row.id);
    },
    async listArchivedAgents() {
      const rows = await db
        .select({ agentId: agents.id, departmentId: agents.departmentId })
        .from(agents)
        .where(eq(agents.status, "archived"));
      return rows;
    },
  };
}

function mapStored(row: MessageRow): StoredMessage {
  return {
    payloadHash: row.payloadHash,
    message: messageSchema.parse({
      messageId: row.id,
      protocolVersion: row.protocolVersion,
      messageType: row.messageType,
      senderAgentId: row.senderAgentId,
      senderDepartmentId: row.senderDepartmentId,
      recipientAgentId: row.recipientAgentId,
      recipientDepartmentId: row.recipientDepartmentId,
      addressingMode: row.addressingMode,
      inboxDepartmentId: row.inboxDepartmentId,
      correlationId: row.correlationId,
      causationId: row.causationId,
      replyToMessageId: row.replyToMessageId,
      priority: row.priority,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      payload: row.payload,
      payloadSchemaVersion: row.payloadSchemaVersion,
      idempotencyKey: row.idempotencyKey,
      metadata: row.metadata,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
    }),
  };
}

function mapOutbox(row: OutboxDbRow): OutboxRow {
  return {
    outboxId: row.id,
    messageId: row.messageId,
    attempt: row.attempt,
    status: row.status as OutboxRow["status"],
    publishAttempts: row.publishAttempts,
    availableAt: row.availableAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    lastError: row.lastError,
    claimedBy: row.claimedBy,
  };
}

function mapProcessing(row: ProcessingDbRow): ProcessingRow {
  return {
    messageId: row.messageId,
    status: row.status as ProcessingStatus,
    attemptCount: row.attemptCount,
    owner: row.owner,
    leaseUntil: row.leaseUntil ? row.leaseUntil.toISOString() : null,
    lastError: row.lastError,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function mapDeadLetter(row: DeadLetterRow, messageType: string | null) {
  return deadLetterSchema.parse({
    deadLetterId: row.id,
    messageId: row.messageId,
    messageType,
    reason: row.reason,
    detail: row.detail,
    attemptCount: row.attemptCount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });
}

async function loadMessage(
  db: DbExecutor,
  id: string,
  lock: boolean,
): Promise<StoredMessage | null> {
  const query = db.select().from(iacpMessages).where(eq(iacpMessages.id, id)).limit(1);
  const rows = lock ? await query.for("update") : await query;
  const row = rows[0];
  return row ? mapStored(row) : null;
}

function visibilityClause(visibility: MessageVisibility): SQL {
  if (visibility.unrestricted) {
    return sql`true`;
  }
  const parts: SQL[] = [];
  if (visibility.agentId) {
    parts.push(eq(iacpMessages.senderAgentId, visibility.agentId));
    parts.push(eq(iacpMessages.recipientAgentId, visibility.agentId));
  }
  if (visibility.departmentId) {
    const department = and(
      eq(iacpMessages.addressingMode, "department"),
      eq(iacpMessages.recipientDepartmentId, visibility.departmentId),
    );
    if (department) {
      parts.push(department);
    }
  }
  return parts.length > 0 ? (or(...parts) ?? sql`false`) : sql`false`;
}

function deadLetterVisibility(visibility: MessageVisibility): SQL {
  if (visibility.unrestricted) {
    return sql`true`;
  }
  return and(isNotNull(messageDeadLetters.messageId), visibilityClause(visibility)) ?? sql`false`;
}

function inboxClause(filter: MessageListFilter): SQL | undefined {
  if (!filter.inbox) {
    return undefined;
  }
  if (filter.inbox === "sent") {
    return filter.visibility.agentId
      ? eq(iacpMessages.senderAgentId, filter.visibility.agentId)
      : sql`false`;
  }
  if (filter.inbox === "agent") {
    return filter.visibility.agentId
      ? eq(iacpMessages.recipientAgentId, filter.visibility.agentId)
      : sql`false`;
  }
  return filter.visibility.departmentId
    ? (and(
        eq(iacpMessages.addressingMode, "department"),
        eq(iacpMessages.recipientDepartmentId, filter.visibility.departmentId),
      ) ?? sql`false`)
    : sql`false`;
}

async function messageTypeOf(db: DbExecutor, messageId: string): Promise<string | null> {
  const [row] = await db
    .select({ messageType: iacpMessages.messageType })
    .from(iacpMessages)
    .where(eq(iacpMessages.id, messageId))
    .limit(1);
  return row?.messageType ?? null;
}

async function countWhere(
  db: DbExecutor,
  table: typeof messageOutbox | typeof messageProcessingRecords | typeof messageDeadLetters,
  where: SQL,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  return Number(row?.value ?? 0);
}
