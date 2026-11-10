# C1.7.4D — Structured Output Reliability

## Confirmed root cause (live GPU `0fe38aab-…`)

Reasoning terminated with `invalid_after_repetition` / `model_invalid: output was not valid JSON` because:

1. The runner already required client-side Zod validation, but Ollama requests used only `response_format: { type: "json_object" }` — **no JSON Schema grammar**.
2. After a **valid but repetitive** draft, the repetition correction regenerate produced **non-JSON** (or unparseable) text.
3. That path previously **terminated immediately** without a further bounded schema/JSON recovery.
4. Failure taxonomy could lump `invalid_after_repetition` toward JSON even when the symptom was schema-related; repetition of *valid* content is now classified separately from parse failures.

This is a **formatting / structured-output reliability** failure, not evidence of improved Reasoning quality.

## Math proposal with zero extractable claims

Deterministic extraction only creates numerical propellant-mass / comparison candidates. A proposal that redefines `m0` (especially as dry/final mass) without an extractable “requires N kg propellant” clause produced **zero candidates**. C1.7.4D now records **unsupported definition candidates** for incorrect/incomplete `m0` usage without verifying or inventing masses.

## Changes

- Pass Ollama-compatible `response_format.json_schema` (`DECISION_RESPONSE_JSON_SCHEMA`) with fallback to `json_object` then none.
- Strip `<think>` wrappers; detect truncated JSON; classify `json_invalid` vs `schema_invalid` vs `contribution_invalid` vs repetition.
- Persist bounded `failureClass` + `outputDigest` on failed generations (no unbounded raw text in progressState).
- One bounded recovery after invalid JSON following a repetition retry (token budget enforced).
- Preserve C1.7.4 verification gates; failed generations never become accepted turns or verified claims.

## Limitations

- Schema enforcement depends on self-hosted Ollama grammar support; Cloud may accept the field without enforcing it — client Zod remains authoritative.
- Recovery can fix formatting; it does **not** improve scientific reasoning.
- `m0` detection is heuristic and marks unsupported definitions; it does not auto-correct the model’s physics.
