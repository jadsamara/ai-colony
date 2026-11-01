import { sql } from "drizzle-orm";
import type { Persistence } from "@ai-colony/core";
import type { Database } from "./client.js";
import { createRepositories } from "./repositories/create-repositories.js";

export function createPersistence(db: Database, close: () => Promise<void>): Persistence {
  return {
    repos: createRepositories(db),
    transaction(work) {
      return db.transaction(async (tx) => work(createRepositories(tx)));
    },
    async ping() {
      await db.execute(sql`select 1`);
    },
    close,
  };
}
