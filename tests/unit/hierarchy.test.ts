import { describe, expect, it } from "vitest";
import { assertNoHierarchyCycle, DomainError } from "@ai-colony/core";

describe("hierarchy", () => {
  it("rejects a parent chain that already includes the subject", () => {
    expect(() => assertNoHierarchyCycle("a", ["c", "b", "a"])).toThrow(DomainError);
  });

  it("allows a parent that is not a descendant", () => {
    expect(() => assertNoHierarchyCycle("c", ["a"])).not.toThrow();
  });

  it("rejects a self parent", () => {
    expect(() => assertNoHierarchyCycle("a", ["a"])).toThrow(DomainError);
  });
});
