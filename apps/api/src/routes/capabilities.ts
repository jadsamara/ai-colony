import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponses, requestContext } from "./common.js";

const idParams = z.object({ id: z.string().uuid() });
const json = z.any();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export async function registerCapabilityRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post("/api/v1/capabilities/topics", {
    schema: {
      tags: ["capabilities"],
      body: z.object({ departmentId: z.string().uuid(), provenance: z.string().min(1).max(500) }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.ledger.registerTopic(requestContext(request), request.body)));

  route.post("/api/v1/capabilities/topics/:id/events", {
    schema: {
      tags: ["capabilities"],
      params: idParams,
      body: z.object({
        eventType: z.enum(["rename", "describe", "deprecate"]),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
      }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.ledger.recordTopicEvent(requestContext(request), request.params.id, request.body)));

  route.post("/api/v1/capabilities/taxonomy/proposals", {
    schema: {
      tags: ["capabilities"],
      body: z.object({
        departmentId: z.string().uuid(),
        nodes: z.array(z.object({
          topicId: z.string().uuid(),
          parentTopicId: z.string().uuid().nullable(),
          name: z.string().min(1).max(200),
          description: z.string().max(2000).nullable(),
          status: z.enum(["active", "deprecated"]),
          crossLinks: z.array(z.string().uuid()).max(32),
        }).strict()).min(1).max(500),
      }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.ledger.proposeTaxonomy(requestContext(request), request.body)));

  route.post("/api/v1/capabilities/taxonomy/proposals/:id/decision", {
    schema: {
      tags: ["capabilities"],
      params: idParams,
      body: z.object({ decision: z.enum(["approved", "rejected"]) }).strict(),
      response: { 200: json, ...errorResponses },
    },
  }, async (request) => app.services.ledger.decideTaxonomy(requestContext(request), request.params.id, request.body.decision));

  route.get("/api/v1/capabilities/taxonomy/versions", {
    schema: {
      tags: ["capabilities"],
      querystring: z.object({ departmentId: z.string().uuid() }).strict(),
      response: { 200: json, ...errorResponses },
    },
  }, async (request) => ({ data: await app.services.ledger.listTaxonomyVersions(requestContext(request), request.query.departmentId) }));

  route.get("/api/v1/capabilities/taxonomy/versions/:id", {
    schema: { tags: ["capabilities"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.ledger.getTaxonomy(requestContext(request), request.params.id));

  route.post("/api/v1/capabilities/mappings/proposals", {
    schema: {
      tags: ["capabilities"],
      body: z.object({
        departmentId: z.string().uuid(),
        taxonomyVersionId: z.string().uuid(),
        items: z.array(z.object({
          itemId: z.string().min(1).max(80),
          contentDigest: digest,
          topicId: z.string().uuid(),
          weight: z.number().gt(0).lte(1).nullable(),
          provenance: z.string().min(1).max(500),
        }).strict()).min(1).max(2000),
      }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.ledger.proposeMapping(requestContext(request), request.body)));

  route.post("/api/v1/capabilities/mappings/proposals/:id/decision", {
    schema: {
      tags: ["capabilities"],
      params: idParams,
      body: z.object({ decision: z.enum(["approved", "rejected"]) }).strict(),
      response: { 200: json, ...errorResponses },
    },
  }, async (request) => app.services.ledger.decideMapping(requestContext(request), request.params.id, request.body.decision));

  route.post("/api/v1/capabilities/snapshots", {
    schema: {
      tags: ["capabilities"],
      body: z.object({
        departmentId: z.string().uuid(),
        topicId: z.string().uuid(),
        taxonomyVersionId: z.string().uuid(),
        mappingVersionId: z.string().uuid(),
        evaluationRunId: z.string().uuid().nullable().optional(),
        evidenceRef: z.string().min(1).max(500),
        manifest: z.record(z.string(), z.unknown()),
        measuredAt: z.string().datetime(),
        correctCount: z.number().int().nonnegative(),
        incorrectCount: z.number().int().nonnegative(),
        failureClasses: z.record(z.string(), z.number().int().nonnegative()),
        measurementMode: z.enum(["closed_book", "retrieval_assisted"]),
        capabilityKind: z.enum(["model", "agent_system"]),
        items: z.array(z.object({
          itemId: z.string().min(1).max(80),
          contentDigest: digest,
          correct: z.boolean().nullable(),
          valid: z.boolean(),
        }).strict()).max(2000),
        provenance: z.string().min(1).max(500),
      }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.ledger.certifySnapshot(requestContext(request), request.body)));

  route.get("/api/v1/capabilities/snapshots/:id", {
    schema: { tags: ["capabilities"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.ledger.getSnapshot(requestContext(request), request.params.id));

  route.get("/api/v1/capabilities/history", {
    schema: {
      tags: ["capabilities"],
      querystring: z.object({ departmentId: z.string().uuid(), topicId: z.string().uuid().optional() }).strict(),
      response: { 200: json, ...errorResponses },
    },
  }, async (request) => ({ data: await app.services.ledger.history(requestContext(request), request.query) }));

  route.post("/api/v1/capabilities/comparisons", {
    schema: {
      tags: ["capabilities"],
      body: z.object({
        baselineId: z.string().uuid(),
        candidateId: z.string().uuid(),
        commonItemDesign: z.boolean().optional(),
        attributeAdapterContrast: z.boolean().optional(),
      }).strict(),
      response: { 200: json, ...errorResponses },
    },
  }, async (request) => app.services.ledger.compare(requestContext(request), request.body));

  route.post("/api/v1/capabilities/retention", {
    schema: {
      tags: ["capabilities"],
      body: z.object({
        snapshotId: z.string().uuid(),
        action: z.enum(["retain", "revoke", "archive"]),
        reason: z.string().min(1).max(500),
      }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.ledger.recordRetention(requestContext(request), request.body.snapshotId, request.body)));

  route.get("/api/v1/capabilities/departments/:id/overview", {
    schema: {
      tags: ["capabilities"],
      params: idParams,
      querystring: z.object({ taxonomyVersionId: z.string().uuid() }).strict(),
      response: { 200: json, ...errorResponses },
    },
  }, async (request) => app.services.ledger.overview(requestContext(request), request.params.id, request.query.taxonomyVersionId));
}
