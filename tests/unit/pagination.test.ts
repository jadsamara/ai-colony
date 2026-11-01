import { describe, expect, it } from "vitest";
import { decodeCursor, DomainError, encodeCursor } from "@ai-colony/core";

describe("pagination cursors", () => {
  it("round-trips a timestamp and id", () => {
    const createdAt = "2026-10-31T22:00:00.000Z";
    const id = "00000000-0000-4000-8000-000000000010";
    const decoded = decodeCursor(encodeCursor(createdAt, id));
    expect(decoded.id).toBe(id);
    expect(decoded.createdAt.toISOString()).toBe(createdAt);
  });

  it("rejects a malformed cursor", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(DomainError);
  });
});
