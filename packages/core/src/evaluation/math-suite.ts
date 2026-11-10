/**
 * C1.8A Math department suite.
 * Ground truth is computed from bound parameters through the allowlisted calculator.
 * Prompts are display text only and are never parsed back into parameters.
 */
import {
  evaluateCalc,
  tsiolkovskyPropellantMass,
  type CalcNode,
} from "../verification/calculation.js";
import { withinTolerance, type ToleranceSpec } from "../verification/tolerance.js";
import { canonicalize, contentDigest, itemSetFingerprint } from "./manifest.js";

export const MATH_SUITE_GENERATOR_VERSION = "c18a-math-v1" as const;
export const C18A_EXPERIMENT_ID = "c18a-math-department-baseline" as const;
export const MATH_SUITE_DEPARTMENT = "math" as const;

export const MATH_SUITE_TOLERANCE: ToleranceSpec = { absolute: 1e-6, relative: 1e-6 };

export const MATH_FAMILIES = [
  "affine",
  "kinetic_energy",
  "ohm_power",
  "tsiolkovsky_propellant",
] as const;
export type MathFamilyId = (typeof MATH_FAMILIES)[number];
export type MathSplit = "train" | "evaluation";

export type MathParameters =
  | {
      family: "affine";
      slope: number;
      intercept: number;
      input: number;
      inputUnit: string;
      outputUnit: string;
    }
  | { family: "kinetic_energy"; massKg: number; speedMps: number }
  | { family: "ohm_power"; currentA: number; resistanceOhm: number }
  | { family: "tsiolkovsky_propellant"; dryMassKg: number; deltaV_m_s: number; isp_s: number };

export interface MathSuiteItem {
  id: string;
  split: MathSplit;
  family: MathFamilyId;
  templateId: string;
  parameters: MathParameters;
  prompt: string;
  expected: number;
  units: string;
  contentDigest: string;
}

export interface FrozenMathSuite {
  generatorVersion: typeof MATH_SUITE_GENERATOR_VERSION;
  experimentId: typeof C18A_EXPERIMENT_ID;
  department: typeof MATH_SUITE_DEPARTMENT;
  phase: "C1.8A";
  groundTruth: "bound_parameters_via_calculator";
  claimExtractor: "not_used";
  tolerance: ToleranceSpec;
  templateIds: { train: string[]; evaluation: string[] };
  contentHash: string;
  itemSetFingerprint: string;
  items: MathSuiteItem[];
}

export interface SolvedMathItem {
  value: number;
  units: string;
  formula: string;
}

const TEMPLATE_SPLIT = {
  "affine.train.rate": "train",
  "affine.train.shift": "train",
  "affine.eval.line": "evaluation",
  "affine.eval.table": "evaluation",
  "kinetic.train.motion": "train",
  "kinetic.train.grams": "train",
  "kinetic.eval.energy": "evaluation",
  "kinetic.eval.grams": "evaluation",
  "ohm.train.resistor": "train",
  "ohm.train.milliamp": "train",
  "ohm.eval.dissipated": "evaluation",
  "ohm.eval.milliamp": "evaluation",
  "tsiolkovsky.train.dry": "train",
  "tsiolkovsky.train.kms": "train",
  "tsiolkovsky.eval.propellant": "evaluation",
  "tsiolkovsky.eval.kms": "evaluation",
} as const;

type TemplateId = keyof typeof TEMPLATE_SPLIT;

interface SuiteRow {
  split: MathSplit;
  templateId: TemplateId;
  parameters: MathParameters;
}

const ROWS: readonly SuiteRow[] = [
  row("train", "affine.train.rate", {
    family: "affine",
    slope: 2,
    intercept: 3,
    input: 4,
    inputUnit: "s",
    outputUnit: "m",
  }),
  row("train", "affine.train.rate", {
    family: "affine",
    slope: 0.5,
    intercept: -1,
    input: 8,
    inputUnit: "s",
    outputUnit: "m",
  }),
  row("train", "affine.train.shift", {
    family: "affine",
    slope: 3,
    intercept: 1,
    input: 5,
    inputUnit: "h",
    outputUnit: "km",
  }),
  row("train", "affine.train.shift", {
    family: "affine",
    slope: -2,
    intercept: 10,
    input: 3,
    inputUnit: "h",
    outputUnit: "km",
  }),
  row("evaluation", "affine.eval.line", {
    family: "affine",
    slope: 4,
    intercept: 2,
    input: 6,
    inputUnit: "s",
    outputUnit: "m",
  }),
  row("evaluation", "affine.eval.line", {
    family: "affine",
    slope: 1.5,
    intercept: 0.5,
    input: 4,
    inputUnit: "s",
    outputUnit: "m",
  }),
  row("evaluation", "affine.eval.table", {
    family: "affine",
    slope: 60,
    intercept: 10,
    input: 2,
    inputUnit: "h",
    outputUnit: "km",
  }),
  row("evaluation", "affine.eval.table", {
    family: "affine",
    slope: 0.25,
    intercept: 2,
    input: 10,
    inputUnit: "min",
    outputUnit: "m",
  }),
  row("train", "kinetic.train.motion", { family: "kinetic_energy", massKg: 2, speedMps: 3 }),
  row("train", "kinetic.train.motion", { family: "kinetic_energy", massKg: 0.5, speedMps: 4 }),
  row("train", "kinetic.train.grams", { family: "kinetic_energy", massKg: 1.2, speedMps: 5 }),
  row("train", "kinetic.train.grams", { family: "kinetic_energy", massKg: 0.25, speedMps: 2 }),
  row("evaluation", "kinetic.eval.energy", { family: "kinetic_energy", massKg: 3, speedMps: 2 }),
  row("evaluation", "kinetic.eval.energy", { family: "kinetic_energy", massKg: 10, speedMps: 1 }),
  row("evaluation", "kinetic.eval.grams", { family: "kinetic_energy", massKg: 0.4, speedMps: 10 }),
  row("evaluation", "kinetic.eval.grams", { family: "kinetic_energy", massKg: 1.5, speedMps: 2 }),
  row("train", "ohm.train.resistor", { family: "ohm_power", currentA: 2, resistanceOhm: 5 }),
  row("train", "ohm.train.resistor", { family: "ohm_power", currentA: 3, resistanceOhm: 4 }),
  row("train", "ohm.train.milliamp", { family: "ohm_power", currentA: 0.5, resistanceOhm: 8 }),
  row("train", "ohm.train.milliamp", { family: "ohm_power", currentA: 1, resistanceOhm: 10 }),
  row("evaluation", "ohm.eval.dissipated", { family: "ohm_power", currentA: 4, resistanceOhm: 2 }),
  row("evaluation", "ohm.eval.dissipated", {
    family: "ohm_power",
    currentA: 0.2,
    resistanceOhm: 50,
  }),
  row("evaluation", "ohm.eval.milliamp", {
    family: "ohm_power",
    currentA: 0.1,
    resistanceOhm: 200,
  }),
  row("evaluation", "ohm.eval.milliamp", { family: "ohm_power", currentA: 1.5, resistanceOhm: 4 }),
  row("train", "tsiolkovsky.train.dry", {
    family: "tsiolkovsky_propellant",
    dryMassKg: 500,
    deltaV_m_s: 1000,
    isp_s: 300,
  }),
  row("train", "tsiolkovsky.train.dry", {
    family: "tsiolkovsky_propellant",
    dryMassKg: 2000,
    deltaV_m_s: 2000,
    isp_s: 450,
  }),
  row("train", "tsiolkovsky.train.kms", {
    family: "tsiolkovsky_propellant",
    dryMassKg: 800,
    deltaV_m_s: 2500,
    isp_s: 320,
  }),
  row("train", "tsiolkovsky.train.kms", {
    family: "tsiolkovsky_propellant",
    dryMassKg: 1500,
    deltaV_m_s: 1500,
    isp_s: 400,
  }),
  row("evaluation", "tsiolkovsky.eval.propellant", {
    family: "tsiolkovsky_propellant",
    dryMassKg: 1000,
    deltaV_m_s: 3000,
    isp_s: 350,
  }),
  row("evaluation", "tsiolkovsky.eval.propellant", {
    family: "tsiolkovsky_propellant",
    dryMassKg: 1000,
    deltaV_m_s: 3000,
    isp_s: 3000,
  }),
  row("evaluation", "tsiolkovsky.eval.kms", {
    family: "tsiolkovsky_propellant",
    dryMassKg: 750,
    deltaV_m_s: 4000,
    isp_s: 420,
  }),
  row("evaluation", "tsiolkovsky.eval.kms", {
    family: "tsiolkovsky_propellant",
    dryMassKg: 1200,
    deltaV_m_s: 1800,
    isp_s: 2800,
  }),
];

function row(split: MathSplit, templateId: TemplateId, parameters: MathParameters): SuiteRow {
  return { split, templateId, parameters };
}

function literal(value: number): CalcNode {
  return { kind: "literal", value };
}

/** Solve from the parameter record. This function has no prompt argument. */
export function solveMathItem(parameters: MathParameters): SolvedMathItem {
  switch (parameters.family) {
    case "affine": {
      const value = evaluateCalc({
        kind: "add",
        left: { kind: "mul", left: literal(parameters.slope), right: literal(parameters.input) },
        right: literal(parameters.intercept),
      });
      return {
        value,
        units: parameters.outputUnit,
        formula: `${formatQuantity(parameters.slope)} * ${formatQuantity(parameters.input)} + ${formatQuantity(parameters.intercept)}`,
      };
    }
    case "kinetic_energy": {
      const value = evaluateCalc({
        kind: "mul",
        left: literal(0.5),
        right: {
          kind: "mul",
          left: literal(parameters.massKg),
          right: { kind: "pow", base: literal(parameters.speedMps), exponent: literal(2) },
        },
      });
      return {
        value,
        units: "J",
        formula: `0.5 * ${formatQuantity(parameters.massKg)} * ${formatQuantity(parameters.speedMps)}^2`,
      };
    }
    case "ohm_power": {
      const value = evaluateCalc({
        kind: "mul",
        left: { kind: "pow", base: literal(parameters.currentA), exponent: literal(2) },
        right: literal(parameters.resistanceOhm),
      });
      return {
        value,
        units: "W",
        formula: `${formatQuantity(parameters.currentA)}^2 * ${formatQuantity(parameters.resistanceOhm)}`,
      };
    }
    case "tsiolkovsky_propellant": {
      const result = tsiolkovskyPropellantMass({
        dryMassKg: parameters.dryMassKg,
        deltaV_m_s: parameters.deltaV_m_s,
        isp_s: parameters.isp_s,
      });
      return {
        value: result.propellantMassKg,
        units: "kg",
        formula: `${formatQuantity(parameters.dryMassKg)} * (exp(${formatQuantity(parameters.deltaV_m_s)} / (${formatQuantity(parameters.isp_s)} * ${formatQuantity(result.g0_m_s2)})) - 1)`,
      };
    }
    default: {
      const _exhaustive: never = parameters;
      throw new Error(`unsupported math family: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("math quantity is not finite");
  }
  return value.toString();
}

export function buildMathSuite(): FrozenMathSuite {
  const items = ROWS.map((entry) => materialize(entry));
  const suite: FrozenMathSuite = {
    generatorVersion: MATH_SUITE_GENERATOR_VERSION,
    experimentId: C18A_EXPERIMENT_ID,
    department: MATH_SUITE_DEPARTMENT,
    phase: "C1.8A",
    groundTruth: "bound_parameters_via_calculator",
    claimExtractor: "not_used",
    tolerance: { ...MATH_SUITE_TOLERANCE },
    templateIds: {
      train: templateIdsFor("train"),
      evaluation: templateIdsFor("evaluation"),
    },
    contentHash: "",
    itemSetFingerprint: "",
    items,
  };
  suite.contentHash = hashItems(items);
  suite.itemSetFingerprint = itemSetFingerprint(
    items.map((item) => ({ id: item.id, contentDigest: item.contentDigest })),
  );
  assertMathSuiteIsolated(suite);
  return suite;
}

export function assertMathSuiteIsolated(suite: FrozenMathSuite): void {
  if (suite.generatorVersion !== MATH_SUITE_GENERATOR_VERSION) {
    throw new Error(`unexpected generator version ${suite.generatorVersion}`);
  }
  if (suite.claimExtractor !== "not_used") {
    throw new Error("math ground truth must not use the claim extractor");
  }
  const train = suite.items.filter((item) => item.split === "train");
  const evaluation = suite.items.filter((item) => item.split === "evaluation");
  if (train.length === 0 || evaluation.length === 0) {
    throw new Error("math suite needs both a training pool and an evaluation split");
  }
  const trainTemplates = new Set(train.map((item) => item.templateId));
  const evaluationTemplates = new Set(evaluation.map((item) => item.templateId));
  for (const templateId of evaluationTemplates) {
    if (trainTemplates.has(templateId)) {
      throw new Error(`template leakage: ${templateId}`);
    }
  }
  if (trainTemplates.size < 2 || evaluationTemplates.size < 2) {
    throw new Error("each split needs multiple templates");
  }
  const families = new Set(suite.items.map((item) => item.family));
  if (families.size !== MATH_FAMILIES.length) {
    throw new Error("math suite is missing an equation family");
  }
  const trainSignatures = new Set(train.map((item) => parameterSignature(item.parameters)));
  const trainPrompts = new Set(train.map((item) => item.prompt));
  const seenIds = new Set<string>();
  for (const item of suite.items) {
    if (seenIds.has(item.id)) {
      throw new Error(`duplicate item id ${item.id}`);
    }
    seenIds.add(item.id);
    if (item.parameters.family !== item.family) {
      throw new Error(`parameter family does not match item ${item.id}`);
    }
    const registered = TEMPLATE_SPLIT[item.templateId as TemplateId];
    if (registered !== item.split) {
      throw new Error(`template ${item.templateId} is not registered for ${item.split}`);
    }
    const solved = solveMathItem(item.parameters);
    if (!withinTolerance(item.expected, solved.value, suite.tolerance).ok) {
      throw new Error(`ground truth drift for ${item.id}`);
    }
    if (item.units !== solved.units) {
      throw new Error(`unit drift for ${item.id}`);
    }
    if (item.contentDigest !== contentDigest(itemCanonical(item))) {
      throw new Error(`content digest drift for ${item.id}`);
    }
  }
  for (const item of evaluation) {
    const signature = parameterSignature(item.parameters);
    if (trainSignatures.has(signature)) {
      throw new Error(`parameter leakage at ${item.id}`);
    }
    if (trainPrompts.has(item.prompt)) {
      throw new Error(`prompt leakage at ${item.id}`);
    }
    for (const prompt of trainPrompts) {
      if (item.prompt.includes(prompt) || prompt.includes(item.prompt)) {
        throw new Error(`prompt overlap at ${item.id}`);
      }
    }
  }
  if (suite.contentHash !== hashItems(suite.items)) {
    throw new Error("suite content hash does not match its items");
  }
  const fingerprint = itemSetFingerprint(
    suite.items.map((item) => ({ id: item.id, contentDigest: item.contentDigest })),
  );
  if (suite.itemSetFingerprint !== fingerprint) {
    throw new Error("suite fingerprint does not match its items");
  }
}

export function verifyFrozenMathSuite(input: unknown): FrozenMathSuite {
  const built = buildMathSuite();
  if (!input || typeof input !== "object") {
    throw new Error("frozen math suite is not an object");
  }
  const contentHash = "contentHash" in input ? input.contentHash : null;
  if (contentHash !== built.contentHash) {
    throw new Error("frozen math suite hash does not match generator c18a-math-v1");
  }
  if (canonicalize(input) !== canonicalize(built)) {
    throw new Error("frozen math suite contents do not match generator c18a-math-v1");
  }
  return built;
}

export function evaluationItems(suite: FrozenMathSuite): MathSuiteItem[] {
  return suite.items.filter((item) => item.split === "evaluation");
}

export function fewShotExamples(suite: FrozenMathSuite): MathSuiteItem[] {
  return MATH_FAMILIES.map((family) => {
    const item = suite.items.find(
      (candidate) => candidate.split === "train" && candidate.family === family,
    );
    if (!item) {
      throw new Error(`missing training example for ${family}`);
    }
    return item;
  });
}

export function workedSolution(item: MathSuiteItem): string {
  const solved = solveMathItem(item.parameters);
  return `${solved.formula} = ${formatQuantity(solved.value)}`;
}

function materialize(entry: SuiteRow): MathSuiteItem {
  if (TEMPLATE_SPLIT[entry.templateId] !== entry.split) {
    throw new Error(`row split does not match template ${entry.templateId}`);
  }
  const solved = solveMathItem(entry.parameters);
  const prompt = renderPrompt(entry.templateId, entry.parameters);
  const draft = {
    split: entry.split,
    family: entry.parameters.family,
    templateId: entry.templateId,
    parameters: entry.parameters,
    prompt,
    expected: solved.value,
    units: solved.units,
  };
  const contentDigestValue = contentDigest(itemCanonical(draft));
  return {
    id: contentDigestValue.slice(0, 32),
    contentDigest: contentDigestValue,
    ...draft,
  };
}

function itemCanonical(item: {
  split: MathSplit;
  family: MathFamilyId;
  templateId: string;
  parameters: MathParameters;
  prompt: string;
  expected: number;
  units: string;
}): string {
  return canonicalize({
    generatorVersion: MATH_SUITE_GENERATOR_VERSION,
    split: item.split,
    family: item.family,
    templateId: item.templateId,
    parameters: item.parameters,
    prompt: item.prompt,
    expected: item.expected,
    units: item.units,
  });
}

function hashItems(items: readonly MathSuiteItem[]): string {
  const body = [...items]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((item) => `${item.id}|${item.contentDigest}|${item.expected}`)
    .join("\n");
  return contentDigest(`${MATH_SUITE_GENERATOR_VERSION}\n${body}`);
}

function parameterSignature(parameters: MathParameters): string {
  return canonicalize(parameters);
}

function templateIdsFor(split: MathSplit): string[] {
  return Object.entries(TEMPLATE_SPLIT)
    .filter(([, registered]) => registered === split)
    .map(([templateId]) => templateId);
}

function renderPrompt(templateId: TemplateId, parameters: MathParameters): string {
  switch (templateId) {
    case "affine.train.rate":
      return affine(
        parameters,
        (value) =>
          `A measured quantity starts at ${n(value.intercept)} ${value.outputUnit} and changes by ${n(value.slope)} ${value.outputUnit} for each ${value.inputUnit}. After ${n(value.input)} ${value.inputUnit}, what is the quantity in ${value.outputUnit}?`,
      );
    case "affine.train.shift":
      return affine(
        parameters,
        (value) =>
          `Start with ${n(value.intercept)} ${value.outputUnit}. Add the product of ${n(value.slope)} and ${n(value.input)}. The input is measured in ${value.inputUnit}. Give the result in ${value.outputUnit}.`,
      );
    case "affine.eval.line":
      return affine(
        parameters,
        (value) =>
          `The relation is y = ${n(value.slope)} * x + ${n(value.intercept)}, where x is in ${value.inputUnit} and y is in ${value.outputUnit}. Compute y when x = ${n(value.input)}.`,
      );
    case "affine.eval.table":
      return affine(
        parameters,
        (value) =>
          `Input (${value.inputUnit}): ${n(value.input)}. Slope: ${n(value.slope)} ${value.outputUnit}/${value.inputUnit}. Intercept: ${n(value.intercept)} ${value.outputUnit}. Report y in ${value.outputUnit}.`,
      );
    case "kinetic.train.motion":
      return kinetic(
        parameters,
        (value) =>
          `An object of mass ${n(value.massKg)} kg moves at ${n(value.speedMps)} m/s. Kinetic energy in joules is one half times mass times speed squared. What is the kinetic energy in J?`,
      );
    case "kinetic.train.grams":
      return kinetic(
        parameters,
        (value) =>
          `A sample has mass ${n(grams(value.massKg))} g (${n(value.massKg)} kg) and speed ${n(value.speedMps)} m/s. Using kilograms and meters per second, what is the kinetic energy in joules?`,
      );
    case "kinetic.eval.energy":
      return kinetic(
        parameters,
        (value) =>
          `Mass = ${n(value.massKg)} kg. Speed = ${n(value.speedMps)} m/s. Compute kinetic energy (1/2 m v^2) in joules.`,
      );
    case "kinetic.eval.grams":
      return kinetic(
        parameters,
        (value) =>
          `Mass = ${n(grams(value.massKg))} g = ${n(value.massKg)} kg. Speed = ${n(value.speedMps)} meters per second. Kinetic energy in J?`,
      );
    case "ohm.train.resistor":
      return ohm(
        parameters,
        (value) =>
          `Current is ${n(value.currentA)} A through a ${n(value.resistanceOhm)} ohm resistor. Power in watts is current squared times resistance. What is the power in W?`,
      );
    case "ohm.train.milliamp":
      return ohm(
        parameters,
        (value) =>
          `Current is ${n(milliamps(value.currentA))} mA (${n(value.currentA)} A) and resistance is ${n(value.resistanceOhm)} ohms. Compute power in watts from the ampere value.`,
      );
    case "ohm.eval.dissipated":
      return ohm(
        parameters,
        (value) =>
          `I = ${n(value.currentA)} A and R = ${n(value.resistanceOhm)} ohm. Electrical power P = I^2 R in watts?`,
      );
    case "ohm.eval.milliamp":
      return ohm(
        parameters,
        (value) =>
          `Current = ${n(milliamps(value.currentA))} mA = ${n(value.currentA)} A. Resistance = ${n(value.resistanceOhm)} ohm. Power in watts?`,
      );
    case "tsiolkovsky.train.dry":
      return rocket(
        parameters,
        (value) =>
          `A stage has dry mass ${n(value.dryMassKg)} kg, delta-v ${n(value.deltaV_m_s)} m/s, and specific impulse ${n(value.isp_s)} s. Use g0 = 9.80665 m/s^2. Propellant mass in kg is dry mass times (exp(delta-v / (Isp * g0)) - 1). What is the propellant mass in kg?`,
      );
    case "tsiolkovsky.train.kms":
      return rocket(
        parameters,
        (value) =>
          `Dry mass ${n(value.dryMassKg)} kg. Delta-v ${n(kilometersPerSecond(value.deltaV_m_s))} km/s, which is ${n(value.deltaV_m_s)} m/s. Specific impulse ${n(value.isp_s)} s. g0 = 9.80665 m/s^2. Propellant mass in kg?`,
      );
    case "tsiolkovsky.eval.propellant":
      return rocket(
        parameters,
        (value) =>
          `Compute propellant mass in kilograms for dry mass ${n(value.dryMassKg)} kg, delta-v ${n(value.deltaV_m_s)} m/s, and specific impulse ${n(value.isp_s)} s. g0 is 9.80665 m/s^2. Formula: m_dry * (exp(delta_v / (Isp * g0)) - 1).`,
      );
    case "tsiolkovsky.eval.kms":
      return rocket(
        parameters,
        (value) =>
          `Dry mass = ${n(value.dryMassKg)} kg. Delta-v = ${n(kilometersPerSecond(value.deltaV_m_s))} km/s = ${n(value.deltaV_m_s)} m/s. Isp = ${n(value.isp_s)} s. g0 = 9.80665 m/s^2. Required propellant mass in kg?`,
      );
    default: {
      const _exhaustive: never = templateId;
      throw new Error(`unknown template ${String(_exhaustive)}`);
    }
  }
}

function affine(
  parameters: MathParameters,
  render: (value: Extract<MathParameters, { family: "affine" }>) => string,
): string {
  if (parameters.family !== "affine") {
    throw new Error("affine template received a different family");
  }
  return render(parameters);
}

function kinetic(
  parameters: MathParameters,
  render: (value: Extract<MathParameters, { family: "kinetic_energy" }>) => string,
): string {
  if (parameters.family !== "kinetic_energy") {
    throw new Error("kinetic template received a different family");
  }
  return render(parameters);
}

function ohm(
  parameters: MathParameters,
  render: (value: Extract<MathParameters, { family: "ohm_power" }>) => string,
): string {
  if (parameters.family !== "ohm_power") {
    throw new Error("ohm template received a different family");
  }
  return render(parameters);
}

function rocket(
  parameters: MathParameters,
  render: (value: Extract<MathParameters, { family: "tsiolkovsky_propellant" }>) => string,
): string {
  if (parameters.family !== "tsiolkovsky_propellant") {
    throw new Error("tsiolkovsky template received a different family");
  }
  return render(parameters);
}

function n(value: number): string {
  return formatQuantity(value);
}

function grams(massKg: number): number {
  return massKg * 1000;
}

function milliamps(currentA: number): number {
  return currentA * 1000;
}

function kilometersPerSecond(deltaV_m_s: number): number {
  return deltaV_m_s / 1000;
}
