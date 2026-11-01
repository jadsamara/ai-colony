import { z } from "zod";
import { DomainError } from "./errors/domain-error.js";

const cursorIdSchema = z.string().uuid();

export interface DecodedCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new DomainError("INVALID_CURSOR", "Invalid pagination cursor", 400);
  }
  const separator = decoded.lastIndexOf("|");
  if (separator <= 0) {
    throw new DomainError("INVALID_CURSOR", "Invalid pagination cursor", 400);
  }
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!cursorIdSchema.safeParse(id).success || Number.isNaN(Date.parse(createdAt))) {
    throw new DomainError("INVALID_CURSOR", "Invalid pagination cursor", 400);
  }
  return { createdAt: new Date(createdAt), id };
}

export function buildPage<T>(
  rows: T[],
  limit: number,
  identify: (row: T) => { createdAt: string; id: string },
): { data: T[]; page: { limit: number; nextCursor: string | null; hasMore: boolean } } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return {
    data,
    page: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last ? encodeCursor(identify(last).createdAt, identify(last).id) : null,
    },
  };
}
