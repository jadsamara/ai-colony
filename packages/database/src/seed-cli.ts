import "dotenv/config";
import { createDatabase } from "./client.js";
import { seed } from "./seed.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { db, close } = createDatabase(databaseUrl);
try {
  const result = await seed(db);
  console.log(
    `Seed complete. Inserted ${result.departmentsInserted} departments and ${result.modelsInserted} models. Existing rows were left unchanged.`,
  );
} finally {
  await close();
}
