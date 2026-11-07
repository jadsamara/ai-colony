import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SYSTEM_ADMINISTRATOR_ID } from "../packages/contracts/dist/index.js";
import {
  Authorizer,
  ConversationRunner,
  DEDICATED_SERVING_POLICY_VERSION,
  DEFAULT_MESSAGING_POLICY,
  DialogueService,
  MessagingService,
  readActivation,
  writeActivationAtomic,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRoute,
  type RequestContext,
} from "../packages/core/dist/index.js";
import { createDatabase, createPersistence, migrateDatabase, seed } from "../packages/database/dist/index.js";
import { OpenAICompatibleProvider } from "../packages/inference/dist/index.js";

const ALLOWED_DATABASE_URL = "postgres://m101:m101@127.0.0.1:5435/colony_m101_integration";
const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
const MODEL = "qwen3:8b";
const SCIENCE_AGENT = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const TOPIC = "Can neural networks learn continuously without catastrophic forgetting?";
const INSTRUCTION = "Independently evaluate continual-learning methods. Challenge unsupported mathematical claims, identify weaknesses, propose falsifiable hypotheses, and produce a concrete experimental protocol comparing replay, EWC, and parameter isolation.";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACTIVATION_PATH = resolve(ROOT, "tmp/local-c151/activation.json");
const ARTIFACT_DIR = resolve(ROOT, "tmp/local-c151");

const databaseUrl = process.env.LOCAL_CONVERSATION_DATABASE_URL ?? ALLOWED_DATABASE_URL;

assertLocalTarget();
if (process.env.COLONY_ACCEPT_TASKS === "true") {
  throw new Error("Refusing to run while COLONY_ACCEPT_TASKS is true");
}
if (process.env.COLONY_DEDICATED_ROUTING === "on") {
  throw new Error("Refusing to run while COLONY_DEDICATED_ROUTING is on");
}

const calls: Array<{ at: string; department: string; model: string; endpoint: string; latencyMs: number }> = [];

const provider = recordingProvider(new OpenAICompatibleProvider({
  baseUrl: OLLAMA_ORIGIN,
  apiKey: null,
  maxConcurrency: 1,
  transportRetries: 0,
  reasoningEffort: "none",
}));

const route: InferenceRoute = {
  memoryProfile: "shared",
  alias: MODEL,
  operationalAlias: null,
  temperature: 0.2,
  maxOutputTokens: 700,
  timeoutMs: 120_000,
  rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
  globalConcurrency: 1,
  departmentConcurrency: 1,
  dedicatedRouting: { enabled: false, instances: [] },
};

const { db, close } = createDatabase(databaseUrl);
const persistence = createPersistence(db, close);
let restore: Record<string, unknown> | null = null;
let activeConversationId: string | null = null;

try {
  await prepareActivation();
  const installed = await installedModel();
  if (!installed) {
    writeArtifact({
      status: "blocked",
      blocker: `${MODEL} is not installed at ${OLLAMA_ORIGIN}. No model download was attempted.`,
    });
    throw new Error(`${MODEL} is not installed at ${OLLAMA_ORIGIN}`);
  }
  console.log(`[local-c151] model=${MODEL} endpoint=${OLLAMA_ORIGIN} routing=shared dedicated=off`);
  await migrateDatabase(db);
  const science = await persistence.repos.objectives.findDepartmentBySlug("science");
  if (!science) {
    console.log("[local-c151] seeding the disposable integration database because Science is absent");
    await seed(db);
  }
  const settings = await persistence.repos.autonomy.settings();
  if (settings.enabled) {
    throw new Error("Refusing to run while CEO autonomous goal generation is enabled");
  }
  restore = {
    enabled: false,
    conversationExecutionEnabled: settings.conversationExecutionEnabled,
    maxConversationMessages: settings.maxConversationMessages,
    maxConversations: settings.maxConversations,
    maxDurationMs: settings.maxDurationMs,
    conversationCheckpointTurns: settings.conversationCheckpointTurns,
    conversationSoftTokenBudget: settings.conversationSoftTokenBudget,
    conversationHardTokenCeiling: settings.conversationHardTokenCeiling,
    maxConcurrentConversationTurns: settings.maxConcurrentConversationTurns,
  };
  await persistence.repos.autonomy.saveSettings({
    enabled: false,
    conversationExecutionEnabled: true,
    maxConversationMessages: 12,
    maxConversations: Math.max(settings.maxConversations, 8),
    maxDurationMs: 45 * 60 * 1000,
    conversationCheckpointTurns: 5,
    conversationSoftTokenBudget: 80_000,
    conversationHardTokenCeiling: 120_000,
    maxConcurrentConversationTurns: 1,
  });
  const authorizer = new Authorizer();
  const dialogue = new DialogueService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY));
  const runner = new ConversationRunner(persistence, authorizer, dialogue);
  const resumeId = process.env.LOCAL_CONVERSATION_ID ?? null;
  const opened = resumeId
    ? { conversationId: resumeId }
    : await dialogue.open(scienceActor(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: TOPIC,
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: `local-c151-${Date.now()}`,
    });
  activeConversationId = opened.conversationId;
  console.log(`[local-c151] conversation=${opened.conversationId} running up to 11 continuation turns`);
  const result = await runner.run(adminActor(), opened.conversationId, provider, route, { maxTurns: resumeId ? 1 : 11 });
  const conversation = await persistence.repos.autonomy.findConversation(opened.conversationId);
  const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
  const checks = verify(turns, conversation?.contextSummary ?? null, conversation?.progressState.turnDecisions ?? []);
  const artifact = {
    status: checks.ok ? "completed" : "completed-with-check-failures",
    topic: TOPIC,
    instruction: INSTRUCTION,
    conversationId: opened.conversationId,
    runner: result,
    routing: {
      mode: "shared-local-ollama",
      dedicatedRoutingEnabled: false,
      activationFile: ACTIVATION_PATH,
      activation: readActivation(ACTIVATION_PATH),
      ollamaOrigin: OLLAMA_ORIGIN,
      model: MODEL,
      note: "Dedicated routing still refuses hosts other than ollama-<slug>. Both departments use the shared local Ollama provider.",
    },
    inferenceCalls: calls,
    lastInferenceEndpoint: conversation?.lastInferenceEndpoint ?? null,
    conversation: conversation
      ? {
          status: conversation.status,
          outcome: conversation.outcome,
          closeReason: conversation.closeReason,
          terminationReason: conversation.progressState.terminationReason,
          checkpointDecision: conversation.progressState.lastDecision,
          paused: conversation.paused,
          runnerStatus: conversation.runnerStatus,
          openingInstruction: conversation.openingInstruction,
          messageCount: conversation.messageCount,
          inputTokens: conversation.inputTokens,
          outputTokens: conversation.outputTokens,
          lastError: conversation.lastError,
        }
      : null,
    progress: conversation?.progressState ?? null,
    checkpoint: conversation?.contextSummary ?? null,
    evidenceRefs: conversation?.evidenceRefs ?? [],
    turns: turns.map((turn) => ({
      sequence: turn.sequence,
      department: turn.departmentSlug,
      kind: turn.kind,
      body: turn.body,
      prompt: turn.prompt,
    })),
    checks,
    assessment: assess(turns, conversation?.progressState.turnDecisions ?? []),
  };
  const path = writeArtifact(artifact);
  console.log(`[local-c151] artifact=${path}`);
  console.log(`[local-c151] stop=${result.stop} turns=${turns.length} checks=${checks.ok ? "passed" : "failed"}`);
  if (!checks.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Local conversation failed";
  console.error(`[local-c151] ${message}`);
  const conversation = activeConversationId ? await persistence.repos.autonomy.findConversation(activeConversationId) : null;
  const turns = activeConversationId ? await persistence.repos.autonomy.listTurns(activeConversationId) : [];
  writeArtifact({
    status: "failed",
    error: message,
    conversationId: activeConversationId,
    inferenceCalls: calls,
    conversation: conversation
      ? {
          status: conversation.status,
          closeReason: conversation.closeReason,
          terminationReason: conversation.progressState.terminationReason,
          messageCount: conversation.messageCount,
          lastError: conversation.lastError,
        }
      : null,
    progress: conversation?.progressState ?? null,
    checkpoint: conversation?.contextSummary ?? null,
    turns: turns.map((turn) => ({ sequence: turn.sequence, department: turn.departmentSlug, kind: turn.kind, body: turn.body, prompt: turn.prompt })),
  });
  process.exitCode = 1;
} finally {
  if (restore) {
    await persistence.repos.autonomy.saveSettings({
      enabled: false,
      conversationExecutionEnabled: restore.conversationExecutionEnabled as boolean,
      maxConversationMessages: restore.maxConversationMessages as number,
      maxConversations: restore.maxConversations as number,
      maxDurationMs: restore.maxDurationMs as number,
      conversationCheckpointTurns: restore.conversationCheckpointTurns as number,
      conversationSoftTokenBudget: restore.conversationSoftTokenBudget as number,
      conversationHardTokenCeiling: restore.conversationHardTokenCeiling as number,
      maxConcurrentConversationTurns: restore.maxConcurrentConversationTurns as number,
    }).catch((error: unknown) => {
      console.error(`[local-c151] settings restore failed: ${error instanceof Error ? error.message : "unknown"}`);
    });
  }
  await close();
}

function assertLocalTarget(): void {
  const parsed = new URL(databaseUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "5435" || name !== "colony_m101_integration") {
    throw new Error("Refusing any database other than 127.0.0.1:5435/colony_m101_integration");
  }
  if (ACTIVATION_PATH.includes(`${resolve(ROOT, "deploy/state")}`)) {
    throw new Error("Refusing the production activation path");
  }
}

function prepareActivation(): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeActivationAtomic(ACTIVATION_PATH, {
    enabled: false,
    policyVersion: DEDICATED_SERVING_POLICY_VERSION,
    activatedAt: null,
    instanceIds: [],
    mode: "real",
  });
  const loaded = readActivation(ACTIVATION_PATH);
  if (!loaded || loaded.enabled || loaded.policyVersion !== DEDICATED_SERVING_POLICY_VERSION) {
    throw new Error("Temporary activation file is not a disabled local record");
  }
  process.env.COLONY_ACTIVATION_FILE = ACTIVATION_PATH;
  process.env.COLONY_DEDICATED_ROUTING = "off";
}

async function installedModel(): Promise<boolean> {
  const response = await fetch(`${OLLAMA_ORIGIN}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    throw new Error(`Ollama probe returned ${response.status}`);
  }
  const body = (await response.json()) as { models?: Array<{ name?: string }> };
  return (body.models ?? []).some((model) => model.name === MODEL || model.name?.startsWith(`${MODEL}:`));
}

function recordingProvider(inner: OpenAICompatibleProvider): InferenceProvider {
  return {
    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const started = Date.now();
      const result = await inner.generate(request);
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      const department = system.match(/You are the (.+?) department/)?.[1] ?? "unknown";
      calls.push({
        at: new Date().toISOString(),
        department,
        model: request.modelAlias,
        endpoint: OLLAMA_ORIGIN,
        latencyMs: Date.now() - started,
      });
      console.log(`[local-c151] inference department=${department} latencyMs=${Date.now() - started}`);
      return result;
    },
    probe: () => inner.probe(),
  };
}

function verify(
  turns: Array<{ sequence: number; prompt: Array<{ role: string; content: string }>; body: string; kind: string }>,
  checkpoint: string | null,
  decisions: string[],
): { ok: boolean; instructionInContinuations: boolean; mathIntact: boolean; unsupportedNotVerified: boolean; failures: string[] } {
  const failures: string[] = [];
  const continuations = turns.filter((turn) => turn.sequence > 1);
  const instructionInContinuations = continuations.every((turn) => turn.prompt.some((message) => message.role === "user" && message.content.includes(INSTRUCTION)));
  if (!instructionInContinuations) {
    failures.push("A continuation prompt omitted the original instruction");
  }
  const mathIntact = turns.every((turn) => !/[\u0008\u000c]/.test(turn.body) && !/\n(?:abla)\b|\t(?:heta|ext|imes)\b/.test(turn.body));
  if (!mathIntact) {
    failures.push("A stored turn contains corrupted mathematical notation");
  }
  const verifiedText = `${checkpoint ?? ""}\n${decisions.join("\n")}`;
  const unsupportedNotVerified = turns.every((turn) => {
    if (turn.kind !== "evidence") {
      return true;
    }
    return /\b(?:observed:|experiment:|doi:|source:|https?:\/\/)\S+/i.test(turn.body);
  }) && !/unsupported[^\n]{0,80}verified/i.test(verifiedText);
  if (!unsupportedNotVerified) {
    failures.push("Unsupported evidence was stored as verified evidence");
  }
  return { ok: failures.length === 0, instructionInContinuations, mathIntact, unsupportedNotVerified, failures };
}

function assess(turns: Array<{ departmentSlug?: string; department?: string; kind: string; body: string }>, decisions: string[]): {
  challengeTurns: number;
  mentionsProtocol: boolean;
  mentionsMethods: string[];
  flaggedMathematics: number;
  summary: string;
} {
  const challengeTurns = turns.filter((turn) => ["challenge", "counterargument", "disagreement"].includes(turn.kind)).length;
  const text = turns.map((turn) => turn.body).join("\n");
  const mentionsMethods = ["replay", "ewc", "parameter isolation"].filter((method) => new RegExp(method, "i").test(text));
  const mentionsProtocol = /protocol|experiment/i.test(text) && mentionsMethods.length === 3;
  const flaggedMathematics = decisions.filter((decision) => decision.startsWith("flagged mathematical")).length;
  const summary = challengeTurns > 0 && mentionsProtocol
    ? "The transcript contains an explicit challenge and names all three methods in an experimental context."
    : "The transcript does not yet show both an explicit challenge and a protocol covering replay, EWC, and parameter isolation.";
  return { challengeTurns, mentionsProtocol, mentionsMethods, flaggedMathematics, summary };
}

function writeArtifact(value: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(ARTIFACT_DIR, `conversation-${stamp}.json`);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, json);
  writeFileSync(resolve(ARTIFACT_DIR, "latest.json"), json);
  return path;
}

function scienceActor(): RequestContext {
  return {
    correlationId: "local-c151",
    actor: {
      principalId: SCIENCE_AGENT,
      principalType: "agent",
      role: "department_agent",
      agentId: SCIENCE_AGENT,
      departmentId: SCIENCE_DEPARTMENT,
      permissions: [],
    },
  };
}

function adminActor(): RequestContext {
  return {
    correlationId: "local-c151",
    actor: {
      principalId: SYSTEM_ADMINISTRATOR_ID,
      principalType: "system",
      role: "system_administrator",
      agentId: null,
      departmentId: null,
      permissions: [],
    },
  };
}
