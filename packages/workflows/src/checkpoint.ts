import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const RETRYABLE_SETUP_CODES = new Set(["23505", "42P07", "42710"]);

export async function openCheckpointer(databaseUrl: string): Promise<PostgresSaver> {
  const checkpointer = PostgresSaver.fromConnString(databaseUrl);
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await checkpointer.setup();
      return checkpointer;
    } catch (error) {
      lastError = error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (!RETRYABLE_SETUP_CODES.has(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw lastError;
}
