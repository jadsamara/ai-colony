import { z } from "zod";
import {
  CREATION_SOURCES,
  DEPARTMENT_STATUSES,
  DEPARTMENT_TYPES,
  SPECIFICATION_VERSION,
} from "../constants.js";
import { resourceBudgetSchema } from "./budget.js";
import {
  metadataSchema,
  pageSchema,
  paginationQuerySchema,
  policyRefSchema,
  slugSchema,
  uuidSchema,
} from "./common.js";

export const departmentStatusSchema = z.enum(DEPARTMENT_STATUSES);
export const departmentTypeSchema = z.enum(DEPARTMENT_TYPES);
export const creationSourceSchema = z.enum(CREATION_SOURCES);

export const departmentSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  slug: slugSchema,
  description: z.string().min(1).max(4000),
  purpose: z.string().min(1).max(2000),
  parentDepartmentId: uuidSchema.nullable(),
  status: departmentStatusSchema,
  departmentType: departmentTypeSchema,
  creationSource: creationSourceSchema,
  createdBy: z.string().min(1).max(128),
  resourceBudget: resourceBudgetSchema,
  policyRef: policyRefSchema.nullable(),
  metadata: metadataSchema,
  specificationVersion: z.literal(SPECIFICATION_VERSION),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const departmentCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: slugSchema,
    description: z.string().trim().min(1).max(4000),
    purpose: z.string().trim().min(1).max(2000),
    parentDepartmentId: uuidSchema.nullable().optional(),
    departmentType: departmentTypeSchema,
    resourceBudget: resourceBudgetSchema,
    policyRef: policyRefSchema.nullable().optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const departmentUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(4000).optional(),
    purpose: z.string().trim().min(1).max(2000).optional(),
    parentDepartmentId: uuidSchema.nullable().optional(),
    policyRef: policyRefSchema.nullable().optional(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export const departmentListQuerySchema = paginationQuerySchema.extend({
  status: departmentStatusSchema.optional(),
  departmentType: departmentTypeSchema.optional(),
  parentDepartmentId: uuidSchema.optional(),
});

export const departmentResponseSchema = z.object({ department: departmentSchema });
export const departmentListResponseSchema = pageSchema(departmentSchema);

export const departmentHierarchyResponseSchema = z.object({
  department: departmentSchema,
  parent: departmentSchema.nullable(),
  children: z.array(departmentSchema),
});

export const departmentFailSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export type Department = z.infer<typeof departmentSchema>;
export type DepartmentCreate = z.infer<typeof departmentCreateSchema>;
export type DepartmentUpdate = z.infer<typeof departmentUpdateSchema>;
export type DepartmentStatus = z.infer<typeof departmentStatusSchema>;
export type DepartmentType = z.infer<typeof departmentTypeSchema>;
export type DepartmentListQuery = z.infer<typeof departmentListQuerySchema>;
