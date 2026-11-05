import type { DedicatedServingInstance, DepartmentProfile } from "./types.js";

export const OLLAMA_IMAGE = "ollama/ollama:0.9.6";
export const AGENT_IMAGE = "ai-colony-agent:m12.1";
export const MOCK_IMAGE = "ai-colony-mock:m12.1";
export const STOP_ARGS = ["stop", "-t", "30"] as const;

export interface ComposeDocument {
  fileName: string;
  yaml: string;
  services: string[];
}

export function renderDedicatedCompose(input: {
  mode: "real" | "mock";
  profiles: readonly DepartmentProfile[];
  instances: readonly DedicatedServingInstance[];
  gpuDeviceIds?: Readonly<Record<string, string>>;
}): ComposeDocument {
  const services: string[] = [];
  const blocks: string[] = [
    "# Generated dedicated department deployment.",
    "# Ollama and mock endpoints are private to the compose network.",
    "# colony stop uses `docker compose stop` and never deletes volumes.",
    input.mode === "mock"
      ? "# MODE=mock. These processes do not load Qwen weights and are not a real-model deployment."
      : "# MODE=real. Do not start this file until provision accepts the GPU capacity limits.",
    "name: ai-colony-dedicated",
    "services:",
  ];
  for (const profile of input.profiles) {
    const instance = input.instances.find((candidate) => candidate.departmentId === profile.departmentId);
    if (!instance) {
      throw new Error(`Department ${profile.slug} has no serving instance`);
    }
    if (input.mode === "mock") {
      blocks.push(mockService(profile, instance));
      blocks.push(mockAgent(profile, instance));
      services.push(`mock-${profile.slug}`, `agent-${profile.slug}`);
    } else {
      blocks.push(ollamaService(profile, instance, input.gpuDeviceIds?.[profile.slug] ?? null));
      blocks.push(realAgent(profile, instance));
      services.push(`ollama-${profile.slug}`, `agent-${profile.slug}`);
    }
  }
  const network = input.mode === "mock" ? "colony-mock" : "colony-dedicated";
  blocks.push("networks:", `  ${network}:`, `    name: ${network}`);
  blocks.push("volumes:");
  for (const profile of input.profiles) {
    blocks.push(`  colony-model-${profile.slug}:`);
  }
  if (!input.profiles.some((profile) => profile.slug === "gaming")) {
    blocks.push("  # Historical Gaming model volume. No active service mounts it, and stop does not delete it.");
    blocks.push("  colony-model-gaming:");
  }
  return {
    fileName: input.mode === "mock" ? "deploy/docker-compose.mock.yml" : "deploy/docker-compose.gcp.yml",
    yaml: `${blocks.join("\n")}\n`,
    services,
  };
}

export function composeStopInvocation(file: string): string[] {
  return ["docker", "compose", "-f", file, ...STOP_ARGS];
}

function workerCommand(slug: string): string {
  if (slug === "ceo" || slug === "orchestration" || slug === "monitoring") {
    return slug;
  }
  return "specialist";
}

function mockService(profile: DepartmentProfile, instance: DedicatedServingInstance): string {
  return `  mock-${profile.slug}:
    image: ${MOCK_IMAGE}
    pull_policy: build
    build:
      context: mock-image
      dockerfile: Dockerfile
    command: ["node", "mock-cli.js"]
    environment:
      COLONY_DEPARTMENT_SLUG: ${profile.slug}
      COLONY_DEPARTMENT_ID: ${profile.departmentId}
      COLONY_INSTANCE_ID: ${instance.instanceId}
      COLONY_BIND: 0.0.0.0
      COLONY_MOCK_PORT: "8080"
      COLONY_MODE: mock
    labels:
      colony.mode: mock
      colony.department: ${profile.slug}
      colony.instance: ${instance.instanceId}
      colony.model: ${instance.modelVersion}
      colony.endpoint: http://mock-${profile.slug}:8080
    networks: [colony-mock]
    mem_limit: 128m
    cpus: 0.25
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 12
      start_period: 5s`;
}

function mockAgent(profile: DepartmentProfile, instance: DedicatedServingInstance): string {
  return `  agent-${profile.slug}:
    image: ${MOCK_IMAGE}
    pull_policy: never
    command: ["node", "department-process.js"]
    environment:
      COLONY_DEPARTMENT_SLUG: ${profile.slug}
      COLONY_DEPARTMENT_ID: ${profile.departmentId}
      COLONY_AGENT_ID: ${profile.agentId}
      COLONY_INSTANCE_ID: ${instance.instanceId}
      COLONY_MODEL_VERSION: ${instance.modelVersion}
      COLONY_ENDPOINT: http://mock-${profile.slug}:8080
      COLONY_MODE: mock
      COLONY_ACCEPT_TASKS: "false"
    labels:
      colony.mode: mock
      colony.department: ${profile.name}
      colony.instance: ${instance.instanceId}
      colony.model: ${instance.modelVersion}
      colony.endpoint: http://mock-${profile.slug}:8080
      colony.memory: ${profile.memoryNamespace}
    depends_on:
      mock-${profile.slug}:
        condition: service_healthy
    networks: [colony-mock]
    mem_limit: 128m
    cpus: 0.25
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8081/status').then((r)=>r.json()).then((b)=>process.exit(b.healthy&&b.mode==='mock'?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 12
      start_period: 5s`;
}

function ollamaService(profile: DepartmentProfile, instance: DedicatedServingInstance, gpuDeviceId: string | null): string {
  const gpu = gpuDeviceId
    ? `
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ["${gpuDeviceId}"]
              capabilities: [gpu]`
    : "";
  return `  ollama-${profile.slug}:
    image: ${OLLAMA_IMAGE}
    environment:
      COLONY_DEPARTMENT_SLUG: ${profile.slug}
      COLONY_INSTANCE_ID: ${instance.instanceId}
      COLONY_MODEL_VERSION: ${instance.modelVersion}
    labels:
      colony.mode: real
      colony.department: ${profile.slug}
      colony.instance: ${instance.instanceId}
      colony.model: ${instance.modelVersion}
      colony.endpoint: http://ollama-${profile.slug}:11434
      colony.gpu: ${gpuDeviceId ?? "unassigned"}
    volumes:
      - colony-model-${profile.slug}:/root/.ollama
    networks: [colony-dedicated]
    mem_limit: 8g
    cpus: 2
    restart: unless-stopped${gpu}
    healthcheck:
      test: ["CMD", "ollama", "list"]
      interval: 15s
      timeout: 5s
      retries: 20
      start_period: 20s`;
}

function realAgent(profile: DepartmentProfile, instance: DedicatedServingInstance): string {
  return `  agent-${profile.slug}:
    image: \${COLONY_AGENT_IMAGE:-${AGENT_IMAGE}}
    pull_policy: \${COLONY_AGENT_PULL_POLICY:-build}
    build:
      context: ..
      dockerfile: deploy/Dockerfile.agent
    command: ["node", "packages/workflows/dist/cli.js", "${workerCommand(profile.slug)}"]
    environment:
      COLONY_DEPARTMENT_SLUG: ${profile.slug}
      COLONY_DEPARTMENT_ID: ${profile.departmentId}
      COLONY_AGENT_ID: ${profile.agentId}
      COLONY_INSTANCE_ID: ${instance.instanceId}
      COLONY_MODEL_VERSION: ${instance.modelVersion}
      COLONY_MODE: real
      COLONY_ACCEPT_TASKS: \${COLONY_ACCEPT_TASKS:-false}
      COLONY_DEDICATED_ROUTING: \${COLONY_DEDICATED_ROUTING:-off}
      COLONY_ACTIVATION_FILE: /var/colony/dedicated-routing.json
      INFERENCE_BASE_URL: http://ollama-${profile.slug}:11434
      INFERENCE_MODEL_ALIAS: \${INFERENCE_MODEL_ALIAS:-qwen3:8b}
      DATABASE_URL: \${DATABASE_URL:-}
      RABBITMQ_URL: \${RABBITMQ_URL:-}
    labels:
      colony.mode: real
      colony.department: ${profile.name}
      colony.instance: ${instance.instanceId}
      colony.model: ${instance.modelVersion}
      colony.endpoint: http://ollama-${profile.slug}:11434
      colony.memory: ${profile.memoryNamespace}
    volumes:
      - \${COLONY_ACTIVATION_HOST_PATH:-./deploy/state}:/var/colony:ro
    depends_on:
      ollama-${profile.slug}:
        condition: service_healthy
    networks: [colony-dedicated]
    mem_limit: 1g
    cpus: 1
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://ollama-${profile.slug}:11434/api/version').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 20
      start_period: 20s`;
}
