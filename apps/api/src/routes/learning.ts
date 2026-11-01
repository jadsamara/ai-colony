import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { trainingDatasetCreateSchema } from "@ai-colony/contracts";
import { errorResponses, requestContext } from "./common.js";

const idParams = z.object({ id: z.string().uuid() });
const json = z.any();

export async function registerLearningRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.get("/api/v1/learning/overview", { schema: { tags: ["learning"], response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.overview(requestContext(request)));
  route.get("/api/v1/learning/cycles", { schema: { tags: ["learning"], querystring: z.object({ departmentId: z.string().uuid().optional() }), response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.listCycles(requestContext(request), request.query.departmentId));
  route.get("/api/v1/learning/cycles/:id", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.getCycle(requestContext(request), request.params.id));
  route.get("/api/v1/learning/cycles/:id/resume", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.resume(requestContext(request), request.params.id));
  route.post("/api/v1/learning/capabilities", {
    schema: { tags: ["learning"], body: z.object({ departmentId: z.string().uuid(), slug: z.string().min(3).max(64), domain: z.string().min(1).max(80), taskType: z.string().min(1).max(80), description: z.string().min(1).max(500), tools: z.array(z.string().min(1).max(64)).max(8) }).strict(), response: { 201: json, ...errorResponses } },
  }, async (request, reply) => reply.status(201).send(await app.services.learning.registerCapability(requestContext(request), request.body)));
  route.post("/api/v1/learning/capabilities/:id/versions/:versionId/approve", {
    schema: { tags: ["learning"], params: z.object({ id: z.string().uuid(), versionId: z.string().uuid() }), response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.learning.approveCapability(requestContext(request), request.params.versionId, request.params.id));
  route.post("/api/v1/learning/gaps", {
    schema: { tags: ["learning"], body: z.object({ departmentId: z.string().uuid(), taskCategory: z.string().min(1).max(80), evidenceKind: z.enum(["evaluation", "task_outcome", "tool_failure", "human_correction"]), evidenceRefs: z.array(z.string().uuid()).min(1).max(20), failureCount: z.number().int().positive().max(10_000), severity: z.enum(["low", "medium", "high"]), impact: z.string().min(1).max(500), proposedMethod: z.enum(["memory_acquisition", "memory_consolidation", "workflow", "retrieval", "lora", "knowledge_transfer", "no_action"]) }).strict(), response: { 201: json, ...errorResponses } },
  }, async (request, reply) => reply.status(201).send(await app.services.learning.observeGap(requestContext(request), request.body)));
  route.post("/api/v1/learning/gaps/:id/validate", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.validateGap(requestContext(request), request.params.id));
  route.post("/api/v1/learning/gaps/:id/objectives", {
    schema: { tags: ["learning"], params: idParams, body: z.object({ weakness: z.string().min(1).max(500), benchmarkVersionId: z.string().uuid().optional() }).strict(), response: { 201: json, ...errorResponses } },
  }, async (request, reply) => reply.status(201).send(await app.services.learning.createObjective(requestContext(request), request.params.id, request.body)));
  route.post("/api/v1/learning/cycles/:id/training-proposal", {
    schema: { tags: ["learning"], params: idParams, body: trainingDatasetCreateSchema.extend({ trainableModelId: z.string().uuid() }), response: { 201: json, ...errorResponses } },
  }, async (request, reply) => {
    const { trainableModelId, ...dataset } = request.body;
    return reply.status(201).send(await app.services.learning.proposeTraining(requestContext(request), request.params.id, dataset, trainableModelId));
  });
  route.post("/api/v1/learning/cycles/:id/approve-training", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.approveTraining(requestContext(request), request.params.id));
  route.post("/api/v1/learning/cycles/:id/execute-training", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.executeTraining(requestContext(request), request.params.id));
  route.post("/api/v1/learning/cycles/:id/evaluate", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.evaluateCycle(requestContext(request), request.params.id));
  route.post("/api/v1/learning/cycles/:id/gate", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.applyGate(requestContext(request), request.params.id));
  route.post("/api/v1/learning/cycles/:id/adopt", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.adopt(requestContext(request), request.params.id));
  route.post("/api/v1/learning/cycles/:id/publish", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.publishResult(requestContext(request), request.params.id));
  route.post("/api/v1/learning/cycles/:id/cancel", { schema: { tags: ["learning"], params: idParams, body: z.object({ reason: z.string().min(1).max(500) }).strict(), response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.cancel(requestContext(request), request.params.id, request.body.reason));
  route.post("/api/v1/learning/transfers", {
    schema: { tags: ["learning"], body: z.object({ destinationDepartmentId: z.string().uuid(), sourceMemoryId: z.string().uuid(), idempotencyKey: z.string().min(8).max(128) }).strict(), response: { 201: json, ...errorResponses } },
  }, async (request, reply) => reply.status(201).send(await app.services.learning.transferKnowledge(requestContext(request), request.body)));
  route.post("/api/v1/learning/transfers/:id/validate", {
    schema: { tags: ["learning"], params: idParams, body: z.object({ decision: z.enum(["accept", "reject"]), reason: z.string().min(1).max(500) }).strict(), response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.learning.validateTransfer(requestContext(request), request.params.id, request.body.decision, request.body.reason));
  route.post("/api/v1/learning/assignments", {
    schema: { tags: ["learning"], body: z.object({ departmentId: z.string().uuid(), role: z.enum(["shared_base", "experimental_adapter", "capability_adapter", "fallback"]), registryModelId: z.string().uuid(), candidateId: z.string().uuid().optional() }).strict(), response: { 201: json, ...errorResponses } },
  }, async (request, reply) => reply.status(201).send(await app.services.learning.assignModel(requestContext(request), request.body)));
  route.post("/api/v1/learning/departments/:id/tools", {
    schema: { tags: ["learning"], params: idParams, body: z.object({ tool: z.string().min(1).max(64), input: z.string().min(1).max(80) }).strict(), response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.learning.executeTool(requestContext(request), request.params.id, request.body.tool, request.body.input));
  route.get("/api/v1/learning/departments/:id", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.resolveDepartment(requestContext(request), request.params.id));
  route.post("/api/v1/learning/cycles/:id/improvement", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.verifyImprovement(requestContext(request), request.params.id));
  route.get("/api/v1/learning/cycles/:id/improvement", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.viewImprovement(requestContext(request), request.params.id));
  route.post("/api/v1/learning/cycles/:id/budget", { schema: { tags: ["learning"], params: idParams, body: z.object({ maxInferenceCalls: z.number().int().nonnegative().optional(), maxTrainingSteps: z.number().int().nonnegative().optional(), maxRuntimeMs: z.number().int().nonnegative().optional() }).strict(), response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.constrainBudget(requestContext(request), request.params.id, request.body));
  route.post("/api/v1/learning/cycles/:id/exceptional-deployment", { schema: { tags: ["learning"], params: idParams, body: z.object({ rationale: z.string().min(1).max(500) }).strict(), response: { 200: json, ...errorResponses } } }, async (request) => app.services.learning.authorizeExceptional(requestContext(request), request.params.id, request.body.rationale));
  route.post("/api/v1/learning/collaborations/consultations", { schema: { tags: ["learning"], body: z.object({ recipientDepartmentId: z.string().uuid(), question: z.string().min(1).max(2000), idempotencyKey: z.string().min(8).max(128), ttlMs: z.number().int().optional() }).strict(), response: { 201: json, ...errorResponses } } }, async (request, reply) => reply.status(201).send(await app.services.collaboration.openConsultation(requestContext(request), request.body)));
  route.post("/api/v1/learning/collaborations/specialist", { schema: { tags: ["learning"], body: z.object({ recipientDepartmentId: z.string().uuid(), question: z.string().min(1).max(2000), idempotencyKey: z.string().min(8).max(128), ttlMs: z.number().int().optional() }).strict(), response: { 201: json, ...errorResponses } } }, async (request, reply) => reply.status(201).send(await app.services.collaboration.openSpecialist(requestContext(request), request.body)));
  route.post("/api/v1/learning/collaborations/joint", { schema: { tags: ["learning"], body: z.object({ recipientDepartmentId: z.string().uuid(), purpose: z.string().min(1).max(200), idempotencyKey: z.string().min(8).max(128) }).strict(), response: { 201: json, ...errorResponses } } }, async (request, reply) => reply.status(201).send(await app.services.collaboration.openJoint(requestContext(request), request.body)));
  route.post("/api/v1/learning/collaborations/:id/accept", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.collaboration.accept(requestContext(request), request.params.id));
  route.post("/api/v1/learning/collaborations/:id/entries", { schema: { tags: ["learning"], params: idParams, body: z.object({ content: z.string().min(1).max(4000), kind: z.enum(["answer", "contribution", "shared_decision"]), provenance: z.enum(["model_generated", "system_observed", "user_provided", "externally_verified"]), idempotencyKey: z.string().min(8).max(128), relevantToRecipientDomain: z.boolean() }).strict(), response: { 201: json, ...errorResponses } } }, async (request, reply) => reply.status(201).send(await app.services.collaboration.contribute(requestContext(request), request.params.id, request.body)));
  route.post("/api/v1/learning/collaborations/entries/:id/retain", { schema: { tags: ["learning"], params: idParams, response: { 201: json, ...errorResponses } } }, async (request, reply) => reply.status(201).send(await app.services.collaboration.retainAnswer(requestContext(request), request.params.id)));
  route.post("/api/v1/learning/collaborations/entries/:id/promote", { schema: { tags: ["learning"], params: idParams, body: z.object({ relevantToRecipientDomain: z.boolean() }).strict(), response: { 200: json, ...errorResponses } } }, async (request) => app.services.collaboration.promote(requestContext(request), request.params.id, request.body.relevantToRecipientDomain));
  route.get("/api/v1/learning/collaborations/:id", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.collaboration.read(requestContext(request), request.params.id));
  route.post("/api/v1/learning/collaborations/:id/close", { schema: { tags: ["learning"], params: idParams, response: { 200: json, ...errorResponses } } }, async (request) => app.services.collaboration.close(requestContext(request), request.params.id));
  route.post("/api/v1/learning/retention/sweep", { schema: { tags: ["learning"], response: { 200: json, ...errorResponses } } }, async (request) => app.services.collaboration.sweep(requestContext(request)));
  route.get("/api/v1/learning/retention/report", { schema: { tags: ["learning"], response: { 200: json, ...errorResponses } } }, async (request) => app.services.collaboration.report(requestContext(request)));
  route.post("/api/v1/learning/forgetting-proposals", {
    schema: { tags: ["learning"], body: z.object({ memoryId: z.string().uuid(), idempotencyKey: z.string().min(8).max(128) }).strict(), response: { 201: json, ...errorResponses } },
  }, async (request, reply) => reply.status(201).send(await app.services.learning.proposeForgetting(requestContext(request), request.body.memoryId, request.body.idempotencyKey)));
}
