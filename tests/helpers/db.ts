import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDatabase,
  migrateDatabase,
  seedFoundations,
  truncateColony,
} from "@ai-colony/database";
import { ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./env.js";

const { db, close } = createDatabase(TEST_DATABASE_URL);

export function testDb() {
  return db;
}

export async function resetFoundations(): Promise<void> {
  await truncateColony(db);
  await seedFoundations(db);
}

export async function closeTestDb(): Promise<void> {
  await close();
}

export async function ensureTestDatabase(): Promise<void> {
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1 });
  try {
    const existing = await admin`select 1 from pg_database where datname = 'ai_colony_test'`;
    if (existing.length === 0) {
      await admin.unsafe("CREATE DATABASE ai_colony_test");
    }
  } finally {
    await admin.end();
  }
  const { db: target, close: closeTarget } = createDatabase(TEST_DATABASE_URL);
  try {
    await migrateDatabase(target);
  } finally {
    await closeTarget();
  }
}

export { sql };
