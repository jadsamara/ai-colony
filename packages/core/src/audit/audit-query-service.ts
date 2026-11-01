import type { AuditEvent, AuditListQuery } from "@ai-colony/contracts";
import type { RequestContext } from "../context.js";
import type { Authorizer } from "../governance/authorizer.js";
import { decodeCursor } from "../pagination.js";
import type { Page, Persistence } from "../ports/repositories.js";

export class AuditQueryService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
  ) {}

  async list(ctx: RequestContext, query: AuditListQuery): Promise<Page<AuditEvent>> {
    this.authorizer.assert(ctx.actor, "audit:read");
    return this.persistence.repos.audit.list({
      limit: query.limit,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
    });
  }
}
