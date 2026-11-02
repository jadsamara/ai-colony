export interface OutboxObservation {
  status: string;
  messageType: string;
  publishAttempts: number;
  updatedAt: string;
  lastError: string | null;
}

export interface OutboxSummary {
  counts: Record<string, number>;
  byType: Array<{ messageType: string; status: string; count: number }>;
  byAttempts: Array<{ publishAttempts: number; count: number }>;
  errors: Array<{ status: string; count: number; sample: string | null }>;
  ages: Array<{ bucket: string; count: number }>;
  fingerprint: Array<{
    status: string;
    count: number;
    oldestUpdate: string;
    newestUpdate: string;
    attempts: number;
  }>;
}

export function summarizeOutbox(rows: readonly OutboxObservation[], now: number): OutboxSummary {
  const counts: Record<string, number> = {};
  const types = new Map<string, number>();
  const attempts = new Map<number, number>();
  const errors = new Map<string, { count: number; sample: string | null }>();
  const ages = new Map<string, number>([
    ["under_1_hour", 0],
    ["under_1_day", 0],
    ["under_7_days", 0],
    ["older", 0],
  ]);
  const fingerprint = new Map<string, { count: number; oldest: string; newest: string; attempts: number }>();

  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    const typeKey = `${row.messageType}\u0000${row.status}`;
    types.set(typeKey, (types.get(typeKey) ?? 0) + 1);
    attempts.set(row.publishAttempts, (attempts.get(row.publishAttempts) ?? 0) + 1);
    if (row.lastError) {
      const current = errors.get(row.status) ?? { count: 0, sample: clip(row.lastError) };
      current.count += 1;
      errors.set(row.status, current);
    }
    const age = now - Date.parse(row.updatedAt);
    const bucket = ageBucket(age);
    ages.set(bucket, (ages.get(bucket) ?? 0) + 1);
    const print = fingerprint.get(row.status) ?? {
      count: 0,
      oldest: row.updatedAt,
      newest: row.updatedAt,
      attempts: 0,
    };
    print.count += 1;
    print.attempts += row.publishAttempts;
    if (row.updatedAt < print.oldest) {
      print.oldest = row.updatedAt;
    }
    if (row.updatedAt > print.newest) {
      print.newest = row.updatedAt;
    }
    fingerprint.set(row.status, print);
  }

  return {
    counts,
    byType: [...types.entries()]
      .map(([key, count]) => {
        const [messageType, status] = key.split("\u0000");
        return { messageType: messageType ?? "", status: status ?? "", count };
      })
      .sort((left, right) => right.count - left.count),
    byAttempts: [...attempts.entries()]
      .map(([publishAttempts, count]) => ({ publishAttempts, count }))
      .sort((left, right) => left.publishAttempts - right.publishAttempts),
    errors: [...errors.entries()].map(([status, value]) => ({ status, ...value })),
    ages: [...ages.entries()].map(([bucket, count]) => ({ bucket, count })),
    fingerprint: [...fingerprint.entries()]
      .map(([status, value]) => ({
        status,
        count: value.count,
        oldestUpdate: value.oldest,
        newestUpdate: value.newest,
        attempts: value.attempts,
      }))
      .sort((left, right) => left.status.localeCompare(right.status)),
  };
}

function ageBucket(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 3_600_000) {
    return "under_1_hour";
  }
  if (ageMs < 86_400_000) {
    return "under_1_day";
  }
  if (ageMs < 7 * 86_400_000) {
    return "under_7_days";
  }
  return "older";
}

function clip(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 120)}…`;
}
