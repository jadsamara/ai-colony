import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const metadataSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (Object.prototype.hasOwnProperty.call(value, "__proto__")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "metadata contains a forbidden key" });
  }
  if (Object.keys(value).length > 50) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "metadata has too many keys" });
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > 16_384) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "metadata exceeds 16KB" });
  }
});

export const policyRefSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.:-]{0,127}$/)
  .describe("Non-authoritative policy label. It does not grant permissions.");

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(2)
  .max(64);

export const memoryNamespaceSchema = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,127}$/);

export const capabilitySchema = z.array(z.string().min(1).max(64)).max(32);

export const performanceMetricsSchema = z
  .record(z.string().min(1).max(64), z.number().finite())
  .superRefine((value, context) => {
    if (Object.keys(value).length > 50) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "performance metrics has too many keys",
      });
    }
  });

export const pageInfoSchema = z.object({
  limit: z.number().int().min(1).max(100),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    page: pageInfoSchema,
  });
}

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
