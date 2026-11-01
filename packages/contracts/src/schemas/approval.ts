import { z } from "zod";
import { APPROVAL_STATUSES, APPROVAL_TARGET_TYPES, APPROVAL_TYPES } from "../constants.js";
import { parameterBudgetSchema, resourceBudgetSchema } from "./budget.js";
import { pageSchema, paginationQuerySchema, uuidSchema } from "./common.js";
import { agentSchema } from "./agent.js";
import { departmentSchema } from "./department.js";

export const approvalTypeSchema = z.enum(APPROVAL_TYPES);
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export const approvalTargetTypeSchema = z.enum(APPROVAL_TARGET_TYPES);

export const approvalSchema = z.object({
  id: uuidSchema,
  approvalType: approvalTypeSchema,
  targetType: approvalTargetTypeSchema,
  targetId: uuidSchema,
  payload: z.record(z.string(), z.unknown()),
  status: approvalStatusSchema,
  requestedBy: uuidSchema,
  decidedBy: uuidSchema.nullable(),
  decisionReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  consumedAt: z.string().datetime().nullable(),
});

const departmentCreateRequestSchema = z
  .object({
    approvalType: z.literal("department_create"),
    targetId: uuidSchema,
  })
  .strict();

const departmentActivateRequestSchema = z
  .object({
    approvalType: z.literal("department_activate"),
    targetId: uuidSchema,
  })
  .strict();

const budgetChangeRequestSchema = z
  .object({
    approvalType: z.literal("budget_change"),
    targetType: approvalTargetTypeSchema,
    targetId: uuidSchema,
    resourceBudget: resourceBudgetSchema.optional(),
    computeBudget: resourceBudgetSchema.optional(),
    parameterBudget: parameterBudgetSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.targetType === "department") {
      if (!value.resourceBudget) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resourceBudget"],
          message: "Department budget changes require resourceBudget",
        });
      }
      if (value.computeBudget || value.parameterBudget) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Department budget changes only accept resourceBudget",
        });
      }
    }
    if (value.targetType === "agent") {
      if (!value.computeBudget || !value.parameterBudget) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Agent budget changes require computeBudget and parameterBudget",
        });
      }
      if (value.resourceBudget) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resourceBudget"],
          message: "Agent budget changes do not accept resourceBudget",
        });
      }
    }
  });

export const approvalRequestSchema = z.union([
  departmentCreateRequestSchema,
  departmentActivateRequestSchema,
  budgetChangeRequestSchema,
]);

export const approvalDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const approvalListQuerySchema = paginationQuerySchema.extend({
  status: approvalStatusSchema.optional(),
  approvalType: approvalTypeSchema.optional(),
  targetId: uuidSchema.optional(),
});

export const approvalResponseSchema = z.object({
  approval: approvalSchema,
  department: departmentSchema.nullable(),
  agent: agentSchema.nullable(),
});

export const approvalListResponseSchema = pageSchema(approvalSchema);

export type Approval = z.infer<typeof approvalSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;
export type ApprovalType = z.infer<typeof approvalTypeSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalTargetType = z.infer<typeof approvalTargetTypeSchema>;
