import { DomainError } from "../errors/domain-error.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function normalizeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError("INVALID_ENDPOINT", "Serving endpoint is not a URL", 400);
  }
  if (url.username || url.password) {
    throw new DomainError("INVALID_ENDPOINT", "Serving endpoint must not carry credentials", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DomainError("INVALID_ENDPOINT", "Serving endpoint must be http or https", 400);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const canonicalHost = LOOPBACK.has(hostname) ? "127.0.0.1" : hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${canonicalHost}:${port}${path}`;
}

export function endpointReferenceFor(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new DomainError("INVALID_ENDPOINT", "Department slug cannot name a serving reference", 400);
  }
  return `serving://${slug}`;
}

export function dedicatedInstanceId(departmentId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(departmentId)) {
    throw new DomainError("INVALID_DEPARTMENT", "Department id is not a UUID", 400);
  }
  return `${departmentId.slice(0, -3)}3${departmentId.slice(-2)}`;
}
