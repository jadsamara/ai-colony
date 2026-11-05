import type { ColonyHealth, LiveModelHealth } from "@ai-colony/contracts";

export type ComponentState = "configured" | "running" | "stopped" | "unavailable" | "unknown" | "stale";

export interface ComponentHealth {
  component: string;
  state: ComponentState;
  evidence: string;
}

export interface HeartbeatEvidence {
  role: string;
  beatAt: string;
}

export function assessPostgres(input: {
  connected: boolean;
  database: string | null;
  dataDirectory: string | null;
  session: "read-only" | "application" | "unknown";
}): ComponentHealth {
  if (!input.connected) {
    return {
      component: "postgresql",
      state: "unavailable",
      evidence: "Connection failed",
    };
  }
  const where = [input.database, input.dataDirectory].filter(Boolean).join(", ");
  return {
    component: "postgresql",
    state: "running",
    evidence: `Connected${where ? ` (${where})` : ""}; session ${input.session}`,
  };
}

export function assessReachable(component: string, reachable: boolean | null, evidence: string): ComponentHealth {
  if (reachable === null) {
    return { component, state: "unknown", evidence };
  }
  return {
    component,
    state: reachable ? "running" : "unavailable",
    evidence,
  };
}

export function assessApi(listening: boolean | null): ComponentHealth {
  if (listening === null) {
    return { component: "fastify-api", state: "unknown", evidence: "Process and port were not inspected" };
  }
  return {
    component: "fastify-api",
    state: listening ? "running" : "stopped",
    evidence: listening ? "API process is accepting requests" : "No API listener was observed",
  };
}

export function assessWorkers(input: {
  heartbeats: readonly HeartbeatEvidence[];
  processSeen: boolean | null;
  now: number;
  staleAfterMs: number;
}): ComponentHealth {
  const newest = input.heartbeats.reduce<number | null>((latest, beat) => {
    const at = Date.parse(beat.beatAt);
    if (!Number.isFinite(at)) {
      return latest;
    }
    return latest === null || at > latest ? at : latest;
  }, null);
  const fresh = newest !== null && input.now - newest <= input.staleAfterMs;
  if (input.processSeen === true || fresh) {
    return {
      component: "langgraph-workers",
      state: "running",
      evidence: fresh ? "A worker heartbeat is inside the freshness window" : "A worker process was observed",
    };
  }
  if (newest !== null) {
    return {
      component: "langgraph-workers",
      state: "stale",
      evidence: `Last heartbeat ${new Date(newest).toISOString()}; ${
        input.processSeen === false ? "no worker process" : "process inspection unavailable"
      }`,
    };
  }
  if (input.processSeen === false) {
    return {
      component: "langgraph-workers",
      state: "unknown",
      evidence: "No worker process and no heartbeat records",
    };
  }
  return {
    component: "langgraph-workers",
    state: "unknown",
    evidence: "Worker process inspection failed and no heartbeats were available",
  };
}

export function assessDispatcher(input: { processSeen: boolean | null; pending: number | null }): ComponentHealth {
  const pending = input.pending === null ? "pending count unknown" : `${input.pending} pending`;
  if (input.processSeen === true) {
    return { component: "outbox-dispatcher", state: "running", evidence: `Publisher process observed; ${pending}` };
  }
  if (input.processSeen === false) {
    return { component: "outbox-dispatcher", state: "stopped", evidence: `Publisher process absent; ${pending}` };
  }
  return { component: "outbox-dispatcher", state: "unknown", evidence: `Publisher process was not inspected; ${pending}` };
}

export function assessRegistry(input: { registered: readonly string[]; installed: readonly string[] } | null): ComponentHealth {
  if (!input) {
    return { component: "model-registry", state: "unknown", evidence: "Registry records were not read" };
  }
  return {
    component: "model-registry",
    state: "configured",
    evidence: `Registered: ${input.registered.join(", ") || "none"}. Ollama tags: ${input.installed.join(", ") || "none"}.`,
  };
}

export function assessTraining(input: {
  provider: string | null;
  processSeen: boolean | null;
  lastExperimentAt: string | null;
}): ComponentHealth {
  const last = input.lastExperimentAt ? `last experiment ${input.lastExperimentAt}` : "no experiment timestamp";
  if (input.processSeen === true) {
    return { component: "training-service", state: "running", evidence: `Trainer process observed; ${last}` };
  }
  if (input.processSeen === null) {
    return {
      component: "training-service",
      state: "unknown",
      evidence: `Process inspection failed; provider ${input.provider ?? "unset"}; ${last}`,
    };
  }
  return {
    component: "training-service",
    state: input.provider ? "configured" : "unknown",
    evidence: `Provider ${input.provider ?? "unset"} is not executing; ${last}`,
  };
}

export function assessOllama(model: LiveModelHealth): ComponentHealth {
  if (!model.live_status.reachable) {
    return {
      component: "ollama",
      state: "unavailable",
      evidence: model.evidence.errors.map((error) => error.message).join("; ") || "Service check failed",
    };
  }
  return {
    component: "ollama",
    state: model.stale ? "stale" : "running",
    evidence: `Installed ${model.live_status.installed}; loaded ${model.live_status.loaded}; inference ${model.inference_ready}`,
  };
}

export function buildRuntimeReport(input: {
  checkedAt: string;
  postgres: Parameters<typeof assessPostgres>[0];
  rabbitReachable: boolean | null;
  apiListening: boolean | null;
  workers: Parameters<typeof assessWorkers>[0];
  dispatcher: Parameters<typeof assessDispatcher>[0];
  registry: Parameters<typeof assessRegistry>[0];
  training: Parameters<typeof assessTraining>[0];
  model: LiveModelHealth;
  outbox: ColonyHealth["outbox"];
}): ColonyHealth {
  return {
    checked_at: input.checkedAt,
    components: [
      assessPostgres(input.postgres),
      assessReachable(
        "rabbitmq",
        input.rabbitReachable,
        input.rabbitReachable === null
          ? "Broker was not inspected"
          : input.rabbitReachable
            ? "TCP connect succeeded; no queue or exchange was declared"
            : "TCP connect failed",
      ),
      assessOllama(input.model),
      assessApi(input.apiListening),
      assessWorkers(input.workers),
      assessDispatcher(input.dispatcher),
      assessRegistry(input.registry),
      assessTraining(input.training),
    ],
    model: input.model,
    outbox: input.outbox,
  };
}
