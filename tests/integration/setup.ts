import { afterAll, beforeEach } from "vitest";
import { closeTestDb, resetFoundations } from "../helpers/db.js";

const major = Number(process.versions.node.split(".")[0] ?? 0);
if (major < 22) {
  throw new Error(
    `Integration tests require Node.js 22+ (repo engines). Current process is Node ${process.versions.node}. ` +
      "Fastify inject fails on Node 18 because light-my-request CJS-requires ESM-only cookie@2; " +
      "LangChain uuid also needs the Node 19+ crypto global. Use nvm/fnm Node 22.",
  );
}

beforeEach(async () => {
  await resetFoundations();
});

afterAll(async () => {
  await closeTestDb();
});
