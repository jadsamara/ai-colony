import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  DEFAULT_EVIDENCE_RETENTION,
  evidenceSha256,
  EXAMPLE_SOURCES,
  FAILURE_CLASSES,
  retainPayload,
  ROLE_PERMISSIONS,
} from "@ai-colony/core";
import { assertAdditiveMigration } from "@ai-colony/database";

describe("C1.6 training evidence foundation", () => {
  it("keeps the failure taxonomy extensible and distinguishes symptoms from verified capability failures", () => {
    expect(FAILURE_CLASSES).toContain("json_invalid");
    expect(FAILURE_CLASSES).toContain("reasoning_error");
    const json = classifyFailure("output was not valid JSON", "invalid_output");
    expect(json).toMatchObject({ failureClass: "json_invalid", provisional: true, confidence: "observed", rootCause: null });
    const schema = classifyFailure("kind: invalid value; body: Required", "invalid_output");
    expect(schema.failureClass).toBe("schema_invalid");
    const repeat = classifyFailure("near-verbatim duplicate of the same mathematical objection", "repetitive");
    expect(repeat.failureClass).toBe("repetition");
    expect(repeat.rootCause).toBeNull();
    expect(repeat.confidence).toBe("observed");
    expect(repeat.evidence).toMatch(/not automatically a verified reasoning deficiency/i);
    expect(repeat.failureClass).not.toBe("reasoning_error");
  });

  it("defaults conversation evidence away from Gemma dataset sources", () => {
    expect(EXAMPLE_SOURCES).not.toContain("conversation");
    expect(EXAMPLE_SOURCES).not.toContain("inference_attempt");
    expect(EXAMPLE_SOURCES).not.toContain("training_evidence");
  });

  it("truncates and hashes retained payloads while redacting secrets", () => {
    const retained = retainPayload(`Bearer secret-token ${"x".repeat(200)} postgres://user:pass@host/db`, 80);
    expect(retained.truncated).toBe(true);
    expect(retained.content?.includes("Bearer [redacted]")).toBe(true);
    expect(retained.content?.includes("[redacted]")).toBe(true);
    expect(retained.content?.includes("secret-token")).toBe(false);
    expect(retained.hash).toHaveLength(64);
    expect(evidenceSha256("abc")).toHaveLength(64);
    expect(DEFAULT_EVIDENCE_RETENTION.rawMaxChars).toBeGreaterThan(1_000);
  });

  it("gates evidence review and eligibility behind dedicated permissions", () => {
    expect(ROLE_PERMISSIONS.department_agent.has("training:evidence:read")).toBe(true);
    expect(ROLE_PERMISSIONS.department_agent.has("training:evidence:correct")).toBe(true);
    expect(ROLE_PERMISSIONS.department_agent.has("training:evidence:review")).toBe(false);
    expect(ROLE_PERMISSIONS.department_agent.has("training:evidence:eligibility")).toBe(false);
    expect(ROLE_PERMISSIONS.system_administrator.has("training:evidence:review")).toBe(true);
    expect(ROLE_PERMISSIONS.system_administrator.has("training:evidence:eligibility")).toBe(true);
    expect(ROLE_PERMISSIONS.read_only_observer.has("training:evidence:read")).toBe(false);
  });

  it("adds an additive training evidence migration", () => {
    const sql = readFileSync("packages/database/src/migrations/0021_training_evidence.sql", "utf8");
    assertAdditiveMigration(sql);
    expect(sql).toContain('CREATE TABLE "training_inference_attempts"');
    expect(sql).toContain('CREATE TABLE "training_evidence_corrections"');
    expect(sql).toContain('CREATE TABLE "training_evidence_correction_events"');
    expect(sql).toContain('CREATE TABLE "training_evidence_eligibility_events"');
    expect(sql).toContain('CREATE TABLE "training_evidence_capture_failures"');
    expect(sql).toContain("training_eligible");
    expect(sql).toContain("failure_class");
    expect(sql.toLowerCase()).not.toContain("drop table");
    expect(sql.toLowerCase()).not.toContain("delete from");
  });
});
