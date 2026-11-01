import { z } from "zod";

const nonnegativeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const cpuAllocationSchema = z
  .object({
    value: nonnegativeInt,
    unit: z.literal("millicores"),
  })
  .strict();

const gpuAllocationSchema = z
  .object({
    value: nonnegativeInt,
    unit: z.literal("devices"),
  })
  .strict();

const memoryAllocationSchema = z
  .object({
    value: nonnegativeInt,
    unit: z.literal("mebibytes"),
  })
  .strict();

const usdMicrosSchema = z
  .object({
    value: nonnegativeInt,
    unit: z.literal("usd_micros"),
  })
  .strict();

const parameterCountSchema = z
  .object({
    value: nonnegativeInt,
    unit: z.literal("parameters"),
  })
  .strict();

const resetPeriodSchema = z
  .object({
    value: z
      .number()
      .int()
      .positive()
      .max(24 * 366),
    unit: z.literal("hours"),
  })
  .strict();

export const resourceBudgetSchema = z
  .object({
    maxConcurrentExecutions: nonnegativeInt,
    maxCpuAllocation: cpuAllocationSchema,
    maxGpuAllocation: gpuAllocationSchema,
    maxMemoryAllocation: memoryAllocationSchema,
    maxEstimatedComputeExpenditure: usdMicrosSchema,
    maxTrainingExpenditure: usdMicrosSchema,
    maxModelParameterCount: parameterCountSchema,
    resetPeriod: resetPeriodSchema.nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const parameterBudgetSchema = z
  .object({
    maxModelParameterCount: parameterCountSchema,
  })
  .strict();

export type ResourceBudget = z.infer<typeof resourceBudgetSchema>;
export type ParameterBudget = z.infer<typeof parameterBudgetSchema>;
