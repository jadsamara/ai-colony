import { z } from "zod";
import {
  EMBEDDING_DIMENSIONS,
  MEMORY_CATEGORIES,
  MEMORY_PROVENANCE,
  MEMORY_PROMOTION_STATUSES,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
} from "../constants.js";
import { pageSchema, paginationQuerySchema, uuidSchema } from "./common.js";

export const memoryScopeSchema = z.enum(MEMORY_SCOPES);
export const memoryCategorySchema = z.enum(MEMORY_CATEGORIES);
export const memoryProvenanceSchema = z.enum(MEMORY_PROVENANCE);
export const memoryStatusSchema = z.enum(MEMORY_STATUSES);
export const memoryPromotionStatusSchema = z.enum(MEMORY_PROMOTION_STATUSES);

export const memorySchema = z.object({
  id: uuidSchema,
  scope: memoryScopeSchema,
  category: memoryCategorySchema,
  ownerAgentId: uuidSchema.nullable(),
  departmentId: uuidSchema.nullable(),
  title: z.string(),
  summary: z.string(),
  content: z.string(),
  provenance: memoryProvenanceSchema,
  status: memoryStatusSchema,
  qualityScore: z.number().min(0).max(1).nullable(),
  qualityCalibrated: z.literal(false),
  embeddingModel: z.string().nullable(),
  embeddingDimensions: z.number().int().nullable(),
  contentHash: z.string(),
  supersededBy: uuidSchema.nullable(),
  originAgentId: uuidSchema.nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const memoryCreateSchema = z.object({
  scope: memoryScopeSchema,
  category: memoryCategorySchema,
  ownerAgentId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(1000),
  content: z.string().trim().min(1).max(8000),
  provenance: memoryProvenanceSchema.default("user_provided"),
  qualityScore: z.number().min(0).max(1).optional(),
  objectiveId: uuidSchema.optional(),
  taskId: uuidSchema.optional(),
  messageId: uuidSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const memoryUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().min(1).max(1000).optional(),
  content: z.string().trim().min(1).max(8000).optional(),
});

export const memoryListQuerySchema = paginationQuerySchema.extend({
  scope: memoryScopeSchema.optional(),
  category: memoryCategorySchema.optional(),
  status: memoryStatusSchema.optional(),
});

export const memorySearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).max(20).default(5),
  minScore: z.number().min(0).max(1).default(0.2),
  scopes: z.array(memoryScopeSchema).max(3).optional(),
  categories: z.array(memoryCategorySchema).max(5).optional(),
  statuses: z.array(memoryStatusSchema).max(5).optional(),
  objectiveId: uuidSchema.optional(),
});

export const memorySearchHitSchema = memorySchema.extend({
  score: z.number(),
  vectorScore: z.number().nullable(),
  keywordScore: z.number(),
  retrievalMode: z.enum(["hybrid", "keyword"]),
});

export const memorySearchResponseSchema = z.object({
  mode: z.enum(["hybrid", "keyword"]),
  hits: z.array(memorySearchHitSchema),
});

export const memoryResponseSchema = z.object({ memory: memorySchema });
export const memoryListResponseSchema = pageSchema(memorySchema);

export const memoryRevisionSchema = z.object({
  id: uuidSchema,
  memoryId: uuidSchema,
  revision: z.number().int(),
  status: memoryStatusSchema,
  summary: z.string(),
  createdAt: z.string().datetime(),
});

export const memoryHistoryResponseSchema = z.object({
  revisions: z.array(memoryRevisionSchema),
});

export const memoryPromoteSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export const memoryPromotionSchema = z.object({
  id: uuidSchema,
  memoryId: uuidSchema,
  fromScope: memoryScopeSchema,
  toScope: memoryScopeSchema,
  status: memoryPromotionStatusSchema,
  reason: z.string(),
  proposedBy: z.string(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
  createdMemoryId: uuidSchema.nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
});

export const memoryPromotionListResponseSchema = pageSchema(memoryPromotionSchema);
export const memoryPromotionResponseSchema = z.object({ promotion: memoryPromotionSchema });

export const memoryDecisionSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export const memoryDisputeSchema = z.object({
  otherMemoryId: uuidSchema,
  reason: z.string().trim().min(1).max(1000),
});

export const memoryConsolidateSchema = z.object({
  memoryIds: z.array(uuidSchema).min(2).max(20).optional(),
  applyNearDuplicates: z.boolean().default(false),
});

export const memoryConsolidationSchema = z.object({
  id: uuidSchema,
  keeperId: uuidSchema,
  mergedIds: z.array(uuidSchema),
  kind: z.enum(["exact", "near"]),
  createdAt: z.string().datetime(),
});

export const memoryConsolidateResponseSchema = z.object({
  applied: z.array(memoryConsolidationSchema),
  proposals: z.array(memoryConsolidationSchema),
});

export const memoryMetricsSchema = z.object({
  byScope: z.record(memoryScopeSchema, z.number().int()),
  byCategory: z.record(memoryCategorySchema, z.number().int()),
  byStatus: z.record(memoryStatusSchema, z.number().int()),
  embeddingFailures: z.number().int(),
  meanEmbeddingLatencyMs: z.number().nullable(),
  retrievals: z.number().int(),
  retrievalHitRate: z.number().nullable(),
  meanRetrievalLatencyMs: z.number().nullable(),
  promotions: z.object({
    pending: z.number().int(),
    approved: z.number().int(),
    rejected: z.number().int(),
  }),
  consolidations: z.number().int(),
  embeddingDimensions: z.literal(EMBEDDING_DIMENSIONS),
});

export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryCategory = z.infer<typeof memoryCategorySchema>;
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemoryRecord = z.infer<typeof memorySchema>;
export type MemoryCreate = z.infer<typeof memoryCreateSchema>;
export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>;
export type MemoryPromotion = z.infer<typeof memoryPromotionSchema>;
export type MemoryMetrics = z.infer<typeof memoryMetricsSchema>;
