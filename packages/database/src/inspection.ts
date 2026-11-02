import postgres from "postgres";

export function assertReadOnlyInspectionUrl(databaseUrl: string): void {
  const port = new URL(databaseUrl).port;
  if (port === "5434") {
    throw new Error("Refusing PostgreSQL port 5434");
  }
}

export function assertDisposableDatabaseUrl(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (parsed.port === "5433" || parsed.port === "5434" || name === "ai_colony") {
    throw new Error("Refusing a canonical or docker PostgreSQL target");
  }
}

export function createReadOnlyInspection(databaseUrl: string) {
  assertReadOnlyInspectionUrl(databaseUrl);
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
    connection: {
      options: "-c default_transaction_read_only=on",
    },
  });
  return {
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
    async assertReadOnly(): Promise<void> {
      const rows = await sql<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
      if (rows[0]?.transaction_read_only !== "on") {
        throw new Error("PostgreSQL session is not read-only");
      }
    },
  };
}
