import { afterAll, beforeEach } from "vitest";
import { closeTestDb, resetFoundations } from "../helpers/db.js";

beforeEach(async () => {
  await resetFoundations();
});

afterAll(async () => {
  await closeTestDb();
});
