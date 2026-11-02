export const PERMITTED_OLLAMA_PATHS = ["/api/version", "/api/tags", "/api/ps"] as const;

export interface OllamaProbeError {
  endpoint: string;
  message: string;
}

export interface OllamaProbe {
  checkedAt: string;
  reachable: boolean;
  version: string | null;
  installedNames: string[];
  loadedNames: string[];
  errors: OllamaProbeError[];
  stale: boolean;
}

export interface OllamaStatusOptions {
  baseUrl: string;
  timeoutMs?: number;
  freshnessMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_FRESHNESS_MS = 60_000;
const DEFAULT_MIN_INTERVAL_MS = 10_000;

export function ollamaProbeUrl(baseUrl: string, path: string): string {
  if (!PERMITTED_OLLAMA_PATHS.includes(path as (typeof PERMITTED_OLLAMA_PATHS)[number])) {
    throw new Error(`Refusing Ollama endpoint ${path}`);
  }
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (url.pathname !== path) {
    throw new Error(`Refusing Ollama endpoint ${url.pathname}`);
  }
  return url.toString();
}

export class OllamaStatusClient {
  private cached: { at: number; probe: Omit<OllamaProbe, "stale"> } | null = null;

  constructor(private readonly options: OllamaStatusOptions) {}

  async inspect(): Promise<OllamaProbe> {
    const now = this.options.now?.() ?? Date.now();
    if (this.cached && now - this.cached.at < this.minIntervalMs) {
      return {
        ...this.cached.probe,
        stale: now - this.cached.at > this.freshnessMs,
      };
    }
    const probe = await this.collect(now);
    this.cached = { at: now, probe };
    return { ...probe, stale: false };
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private get freshnessMs(): number {
    return this.options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  }

  private get minIntervalMs(): number {
    return this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  private async collect(now: number): Promise<Omit<OllamaProbe, "stale">> {
    const errors: OllamaProbeError[] = [];
    const version = await this.readJson("/api/version");
    if (!version.ok) {
      errors.push({ endpoint: "/api/version", message: version.error });
      return {
        checkedAt: new Date(now).toISOString(),
        reachable: false,
        version: null,
        installedNames: [],
        loadedNames: [],
        errors,
      };
    }
    const versionValue = stringField(version.value, "version");
    const tags = namesFrom(await this.readJson("/api/tags"));
    const ps = namesFrom(await this.readJson("/api/ps"));
    if (tags.error) {
      errors.push({ endpoint: "/api/tags", message: tags.error });
    }
    if (ps.error) {
      errors.push({ endpoint: "/api/ps", message: ps.error });
    }
    return {
      checkedAt: new Date(now).toISOString(),
      reachable: true,
      version: versionValue,
      installedNames: tags.names,
      loadedNames: ps.names,
      errors,
    };
  }

  private async readJson(path: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const url = ollamaProbeUrl(this.options.baseUrl, path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      const text = await response.text();
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, error: "malformed JSON" };
      }
    } catch (error) {
      return { ok: false, error: probeError(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function namesFrom(result: { ok: true; value: unknown } | { ok: false; error: string }): {
  names: string[];
  error: string | null;
} {
  if (!result.ok) {
    return { names: [], error: result.error };
  }
  try {
    return { names: modelNames(result.value), error: null };
  } catch (error) {
    return { names: [], error: error instanceof Error ? error.message : "malformed JSON" };
  }
}

function modelNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) {
    throw new Error("malformed JSON");
  }
  return value.models
    .map((model) => (model && typeof model === "object" && "name" in model ? model.name : null))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || !(key in value)) {
    return null;
  }
  const field = value[key as keyof typeof value];
  return typeof field === "string" ? field : null;
}

function probeError(error: unknown): string {
  if (error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))) {
    return "timeout";
  }
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause && cause.code === "ECONNREFUSED") {
    return "connection refused";
  }
  if (error instanceof Error && error.message.toLowerCase().includes("econnrefused")) {
    return "connection refused";
  }
  if (error instanceof Error) {
    return error.message.slice(0, 200);
  }
  return "probe failed";
}
