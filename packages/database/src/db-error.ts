import { DomainError } from "@ai-colony/core";

interface PostgresErrorShape {
  code: string;
  constraint_name?: string;
}

const CONSTRAINT_MESSAGES: Record<string, { code: string; message: string }> = {
  departments_name_unique: {
    code: "CONFLICT",
    message: "A department with that name already exists",
  },
  departments_slug_unique: {
    code: "CONFLICT",
    message: "A department with that slug already exists",
  },
  agents_department_name_unique: {
    code: "CONFLICT",
    message: "An agent with that name already exists in the department",
  },
  agents_memory_namespace_unique: {
    code: "CONFLICT",
    message: "That memory namespace is already in use",
  },
  principals_agent_id_unique: { code: "CONFLICT", message: "That agent already has a principal" },
  models_lineage_version_unique: {
    code: "MODEL_VERSION_CONFLICT",
    message: "That model version already exists",
  },
  messages_sender_idempotency_idx: {
    code: "IDEMPOTENCY_CONFLICT",
    message: "This idempotency key was already used",
  },
  approval_requests_one_pending_idx: {
    code: "APPROVAL_ALREADY_PENDING",
    message: "An approval of this type is already pending for the target",
  },
  department_routing_decisions_idempotency_unique: {
    code: "IDEMPOTENCY_CONFLICT",
    message: "This department routing idempotency key was already used",
  },
};

export function rethrowAsDomainError(error: unknown): never {
  if (error instanceof DomainError) {
    throw error;
  }
  const postgresError = findPostgresError(error);
  if (postgresError?.code === "23505") {
    const mapped = postgresError.constraint_name
      ? CONSTRAINT_MESSAGES[postgresError.constraint_name]
      : undefined;
    throw new DomainError(
      mapped?.code ?? "CONFLICT",
      mapped?.message ?? "Unique constraint violated",
      409,
      {
        constraint: postgresError.constraint_name ?? null,
      },
    );
  }
  if (postgresError?.code === "23503") {
    throw new DomainError("INVALID_REFERENCE", "Referenced record does not exist", 422, {
      constraint: postgresError.constraint_name ?? null,
    });
  }
  if (postgresError?.code === "23514") {
    throw new DomainError(
      "VALIDATION_ERROR",
      "A database check constraint rejected the write",
      422,
      {
        constraint: postgresError.constraint_name ?? null,
      },
    );
  }
  if (postgresError?.code === "40P01" || postgresError?.code === "40001") {
    throw new DomainError(
      "CONFLICT",
      "The request conflicted with a concurrent update. Retry it.",
      409,
    );
  }
  throw error;
}

export async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    rethrowAsDomainError(error);
  }
}

function findPostgresError(error: unknown): PostgresErrorShape | null {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if ("code" in current && typeof current.code === "string") {
      const constraint =
        "constraint_name" in current && typeof current.constraint_name === "string"
          ? current.constraint_name
          : undefined;
      return constraint
        ? { code: current.code, constraint_name: constraint }
        : { code: current.code };
    }
    if ("cause" in current) {
      queue.push(current.cause);
    }
  }
  return null;
}
