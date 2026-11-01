import { z } from "zod";
import { DEPLOYMENT_TARGETS, MODEL_STATUSES, QUANTIZATIONS } from "../constants.js";
import { capabilitySchema, pageSchema, paginationQuerySchema, uuidSchema } from "./common.js";

export const modelStatusSchema = z.enum(MODEL_STATUSES);
export const deploymentTargetSchema = z.enum(DEPLOYMENT_TARGETS);
export const quantizationSchema = z.enum(QUANTIZATIONS);

const modelFieldsSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  modelFamily: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  provider: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  parameterCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modelType: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  artifactUri: z.string().trim().min(1).max(2000).nullable(),
  deploymentTarget: deploymentTargetSchema,
  status: modelStatusSchema,
  quantization: quantizationSchema.nullable(),
  contextWindow: z.number().int().positive().max(10_000_000).nullable(),
  capabilities: capabilitySchema,
  trainable: z.boolean(),
});

export const modelSchema = modelFieldsSchema.extend({
  id: uuidSchema,
  lineageId: uuidSchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const modelRegisterSchema = modelFieldsSchema.strict();

export const modelVersionRegisterSchema = modelFieldsSchema.strict();

export const modelStatusUpdateSchema = z
  .object({
    status: modelStatusSchema,
  })
  .strict();

export const modelListQuerySchema = paginationQuerySchema.extend({
  status: modelStatusSchema.optional(),
  lineageId: uuidSchema.optional(),
});

export const modelResponseSchema = z.object({ model: modelSchema });
export const modelListResponseSchema = pageSchema(modelSchema);

export type ModelRecord = z.infer<typeof modelSchema>;
export type ModelRegister = z.infer<typeof modelRegisterSchema>;
export type ModelListQuery = z.infer<typeof modelListQuerySchema>;
export type ModelStatus = z.infer<typeof modelStatusSchema>;
