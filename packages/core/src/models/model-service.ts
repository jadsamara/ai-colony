import { randomUUID } from "node:crypto";
import type { ModelListQuery, ModelRecord, ModelRegister, ModelStatus } from "@ai-colony/contracts";
import { modelRegisterSchema } from "@ai-colony/contracts";
import { snapshot, type RequestContext } from "../context.js";
import { notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import { decodeCursor } from "../pagination.js";
import type { Page, Persistence } from "../ports/repositories.js";

export class ModelService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
  ) {}

  async register(ctx: RequestContext, input: ModelRegister): Promise<ModelRecord> {
    this.authorizer.assert(ctx.actor, "model:register");
    const fields = modelRegisterSchema.parse(input);
    const id = randomUUID();
    return this.persistence.transaction(async (repos) => {
      const model = await repos.models.insert({
        id,
        lineageId: id,
        version: 1,
        ...fields,
      });
      await repos.audit.append({
        eventType: "model.registered",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "model",
        targetId: model.id,
        action: "register",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: snapshot(model),
        metadata: { lineageId: model.lineageId, version: model.version },
      });
      return model;
    });
  }

  async registerVersion(
    ctx: RequestContext,
    modelId: string,
    input: ModelRegister,
  ): Promise<ModelRecord> {
    this.authorizer.assert(ctx.actor, "model:register");
    const fields = modelRegisterSchema.parse(input);
    return this.persistence.transaction(async (repos) => {
      const existing = await repos.models.findById(modelId);
      if (!existing) {
        throw notFound("Model");
      }
      const version = (await repos.models.maxVersion(existing.lineageId)) + 1;
      const model = await repos.models.insert({
        id: randomUUID(),
        lineageId: existing.lineageId,
        version,
        ...fields,
      });
      await repos.audit.append({
        eventType: "model.version_registered",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "model",
        targetId: model.id,
        action: "register-version",
        correlationId: ctx.correlationId,
        beforeState: snapshot(existing),
        afterState: snapshot(model),
        metadata: { lineageId: model.lineageId, version: model.version },
      });
      return model;
    });
  }

  async updateStatus(
    ctx: RequestContext,
    modelId: string,
    status: ModelStatus,
  ): Promise<ModelRecord> {
    this.authorizer.assert(ctx.actor, "model:register");
    return this.persistence.transaction(async (repos) => {
      const existing = await repos.models.findById(modelId);
      if (!existing) {
        throw notFound("Model");
      }
      if (existing.status === status) {
        return existing;
      }
      const updated = await repos.models.updateStatus(modelId, status);
      await repos.audit.append({
        eventType: "model.status_changed",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "model",
        targetId: modelId,
        action: "update-status",
        correlationId: ctx.correlationId,
        beforeState: snapshot(existing),
        afterState: snapshot(updated),
        metadata: {},
      });
      return updated;
    });
  }

  async get(id: string): Promise<ModelRecord> {
    const model = await this.persistence.repos.models.findById(id);
    if (!model) {
      throw notFound("Model");
    }
    return model;
  }

  async list(query: ModelListQuery): Promise<Page<ModelRecord>> {
    return this.persistence.repos.models.list({
      limit: query.limit,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.lineageId ? { lineageId: query.lineageId } : {}),
    });
  }
}
