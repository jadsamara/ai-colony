import { MockDepartmentServer } from "./mock-department.js";

const slug = process.env.COLONY_DEPARTMENT_SLUG ?? process.argv[2] ?? "";
if (!slug) {
  process.stderr.write("COLONY_DEPARTMENT_SLUG is required\n");
  process.exit(1);
}
const server = new MockDepartmentServer(
  process.env.COLONY_INSTANCE_ID ?? slug,
  process.env.COLONY_DEPARTMENT_ID ?? slug,
);
if (process.env.COLONY_MOCK_FAIL === "1") {
  server.failing = true;
}
const port = Number(process.env.COLONY_MOCK_PORT ?? 8080);
await server.start(process.env.COLONY_BIND ?? "0.0.0.0", port);
process.stdout.write(`mock mode=mock department=${slug} instance=${server.instanceId} endpoint=${server.endpoint()}\n`);
await new Promise(() => undefined);
