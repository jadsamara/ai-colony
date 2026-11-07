import type { ChatMessage } from "../inference/provider.js";

export function normalizeGoal(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function acceptGoalEvidence(evidence: readonly string[], observations: readonly string[]): boolean {
  return evidence.length > 0 && evidence.every((item) => item.startsWith("observed: ") && observations.includes(item.slice("observed: ".length)));
}

export function goalPrompt(observations: readonly string[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the CEO selecting at most one colony-wide goal.",
        "Use only the observation lines. Every evidence item must be exactly \"observed: \" plus one full observation line.",
        "Put guesses in hypotheses. Do not write a hypothesis as evidence.",
        "If no observation shows a gap worth pursuing, return {\"decline\":true,\"reason\":\"No observed gap is present.\"}.",
        "Do not grant permissions, create departments, change governance, or disable auditing.",
        "Return one JSON object with decline, or with goal, motivation, evidence, hypotheses, expectedBenefit, successCriteria, estimatedResources, departments, priority, and stopConditions.",
      ].join(" "),
    },
    {
      role: "user",
      content: observations.map((line) => `- ${line}`).join("\n"),
    },
  ];
}

export function dialoguePrompt(input: {
  departmentName: string;
  topic: string;
  kind: string;
  instruction: string;
  openingInstruction?: string | null;
  transcript: Array<{ department: string; kind: string; body: string }>;
  objective?: string | null;
  summary?: string | null;
  directed?: string[];
  disagreements?: string[];
  evidence?: string[];
}): ChatMessage[] {
  const transcript = input.transcript.length
    ? input.transcript.map((turn) => `${turn.department} (${turn.kind}): ${clip(turn.body)}`).join("\n")
    : "(none)";
  const summary = input.summary ?? "(none)";
  return [
    {
      role: "system",
      content: `You are the ${input.departmentName} department. Department role: ${input.departmentName}. Speech act: ${input.kind}. Write only the message body. A summary line is not a verbatim message. Do not invent tool results, citations, credentials, private memory, or a private chain of thought.`,
    },
    {
      role: "user",
      content: [
        `Colony goal: ${input.objective?.trim() || "(none)"}`,
        `Topic: ${input.topic}`,
        `Original instruction: ${input.openingInstruction?.trim() || input.instruction}`,
        `Instruction: ${input.instruction}`,
        `Questions directed at you:\n${list(input.directed)}`,
        `Disagreements:\n${list(input.disagreements)}`,
        `Evidence:\n${list(input.evidence)}`,
        `Earlier context:\n${summary}`,
        `Recent transcript:\n${transcript}`,
      ].join("\n"),
    },
  ];
}

function list(lines: string[] | undefined): string {
  return lines && lines.length > 0 ? lines.map((line) => clip(line)).join("\n") : "(none)";
}

function clip(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

export function redactSensitive(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
    .replace(/amqps?:\/\/\S+/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/password=\S+/gi, "password=[redacted]");
}

export function redactMessages(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  return messages.map((message) => ({ role: message.role, content: redactSensitive(message.content) }));
}
