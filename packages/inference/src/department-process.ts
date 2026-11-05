import { createServer } from "node:http";

const slug = process.env.COLONY_DEPARTMENT_SLUG ?? "";
const endpoint = process.env.COLONY_ENDPOINT ?? "";
const mode = process.env.COLONY_MODE ?? "";
const instanceId = process.env.COLONY_INSTANCE_ID ?? "";
const modelVersion = process.env.COLONY_MODEL_VERSION ?? "";
if (!slug || !endpoint || (mode !== "mock" && mode !== "real")) {
  process.stderr.write("Department process requires a slug, an endpoint, and mode mock or real\n");
  process.exit(1);
}
let host = "";
try {
  host = new URL(endpoint).hostname;
} catch {
  process.stderr.write("Department endpoint is not a URL\n");
  process.exit(1);
}
if (host !== `mock-${slug}` && host !== `ollama-${slug}`) {
  process.stderr.write(`Refusing endpoint host ${host} for ${slug}\n`);
  process.exit(1);
}

let healthy = false;
let lastError = "";

async function probe(): Promise<void> {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
    healthy = response.ok;
    lastError = healthy ? "" : `HTTP ${response.status}`;
  } catch (error) {
    healthy = false;
    lastError = error instanceof Error ? error.message : "probe failed";
  }
}

await probe();
setInterval(() => {
  void probe();
}, 2000);

const server = createServer((request, response) => {
  if (request.url === "/status") {
    const body = {
      mode,
      department: slug,
      instanceId,
      modelVersion,
      endpoint,
      healthy,
      lastError,
      acceptsTasks: false,
    };
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(8081, "0.0.0.0", () => {
  process.stdout.write(`agent mode=${mode} department=${slug} instance=${instanceId} endpoint=${endpoint}\n`);
});
