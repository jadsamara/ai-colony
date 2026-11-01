import type { Message } from "@ai-colony/contracts";
import {
  InferenceError,
  MessageHandlingError,
  recordReceipt,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceRoute,
  type MessageHandler,
  type ObjectiveService,
  type PreparedGeneration,
} from "@ai-colony/core";

export async function executePrepared(
  service: ObjectiveService,
  provider: InferenceProvider,
  prepared: PreparedGeneration,
  route: InferenceRoute,
  signal?: AbortSignal,
): Promise<string | null> {
  if (prepared.action !== "generate") {
    return null;
  }
  if (prepared.cachedText) {
    return prepared.cachedText;
  }
  const request: InferenceRequest = {
    requestId: prepared.requestId,
    registryModelId: prepared.registryModelId,
    modelAlias: prepared.modelAlias,
    messages: prepared.messages,
    temperature: prepared.temperature,
    maxOutputTokens: prepared.maxOutputTokens,
    timeoutMs: prepared.timeoutMs,
    jsonObject: prepared.purpose === "plan" || prepared.purpose === "correct",
    signal,
  };
  try {
    const result = await provider.generate(request);
    await service.completeGeneration({
      requestId: prepared.requestId,
      text: result.text,
      servedModel: result.servedModel,
      usage: result.usage,
      latencyMs: result.latencyMs,
      route,
    });
    return result.text;
  } catch (error) {
    await service.failGeneration(prepared.requestId, error instanceof Error ? error.message : "inference failed");
    if (error instanceof InferenceError && error.retryable) {
      throw new MessageHandlingError(error.message, false);
    }
    throw error;
  }
}

export function objectiveMessageHandler(input: {
  service: ObjectiveService;
  provider: InferenceProvider;
  route: InferenceRoute;
  workerId: string;
  role: "specialist" | "orchestration";
}): MessageHandler {
  return async (message: Message) => {
    if (
      input.role === "specialist" &&
      message.messageType === "TASK_REQUEST" &&
      message.metadata.kind === "objective-task"
    ) {
      const prepared = await input.service.claimSpecialist(message, input.workerId, input.route);
      if (prepared.action === "wait") {
        throw new MessageHandlingError("Specialist inference is already leased", false);
      }
      if (prepared.action === "generate") {
        const text = await executePrepared(input.service, input.provider, prepared, input.route);
        if (text) {
          await input.service.publishSpecialistResult(message, text);
        }
      }
      return;
    }
    if (
      input.role === "orchestration" &&
      message.messageType === "TASK_RESULT" &&
      message.metadata.kind === "objective-result"
    ) {
      await input.service.applyResult(message);
      return;
    }
    await recordReceipt(message);
  };
}
