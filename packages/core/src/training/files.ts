import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DomainError } from "../errors/domain-error.js";
import { assertInsideRoot, assertRealFileInside } from "./paths.js";

const DTYPE_BYTES: Record<string, number> = {
  F64: 8,
  F32: 4,
  F16: 2,
  BF16: 2,
  I64: 8,
  I32: 4,
  I16: 2,
  I8: 1,
  U8: 1,
  BOOL: 1,
};

export interface TensorInspection {
  tensors: number;
  parameters: number;
  hasLora: boolean;
}

export function sha256File(root: string, target: string): string {
  const real = assertRealFileInside(root, target);
  return createHash("sha256").update(readFileSync(real)).digest("hex");
}

export function writeInside(root: string, relativePath: string, bytes: Buffer | string): string {
  const target = assertInsideRoot(root, `${root}/${relativePath}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}

export function readInside(root: string, target: string): Buffer {
  return readFileSync(assertRealFileInside(root, target));
}

export function assertTrainableBuffer(bytes: Buffer): number {
  if (bytes.length < 16) {
    throw new DomainError("ARTIFACT_MISMATCH", "Adapter file does not contain trainable weights", 422);
  }
  if (!bytes.some((value) => value !== 0)) {
    throw new DomainError("ARTIFACT_MISMATCH", "Adapter weights are all zeros", 422);
  }
  return bytes.length / 4;
}

export function inspectSafetensors(bytes: Buffer): TensorInspection {
  if (bytes.length < 8) {
    throw new DomainError("ARTIFACT_MISMATCH", "Safetensors file is truncated", 422);
  }
  const headerLength = Number(bytes.readBigUInt64LE(0));
  if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || 8 + headerLength > bytes.length) {
    throw new DomainError("ARTIFACT_MISMATCH", "Safetensors header is invalid", 422);
  }
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(bytes.subarray(8, 8 + headerLength).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new DomainError("ARTIFACT_MISMATCH", "Safetensors header is not JSON", 422);
  }
  let tensors = 0;
  let parameters = 0;
  let hasLora = false;
  for (const [key, value] of Object.entries(header)) {
    if (key === "__metadata__") {
      continue;
    }
    if (!value || typeof value !== "object") {
      throw new DomainError("ARTIFACT_MISMATCH", "Safetensors tensor entry is invalid", 422);
    }
    const info = value as { dtype?: string; shape?: number[]; data_offsets?: number[] };
    if (!info.dtype || !DTYPE_BYTES[info.dtype] || !Array.isArray(info.shape) || !Array.isArray(info.data_offsets)) {
      throw new DomainError("ARTIFACT_MISMATCH", "Safetensors tensor metadata is invalid", 422);
    }
    const count = info.shape.reduce((total, dimension) => total * dimension, 1);
    parameters += count;
    tensors += 1;
    if (key.toLowerCase().includes("lora")) {
      hasLora = true;
    }
  }
  if (tensors === 0 || parameters === 0 || !hasLora) {
    throw new DomainError("ARTIFACT_MISMATCH", "Adapter does not contain LoRA tensors", 422);
  }
  return { tensors, parameters, hasLora };
}
