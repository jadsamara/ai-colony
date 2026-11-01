export function logEvent(
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown>,
): void {
  process.stdout.write(
    `${JSON.stringify({
      level,
      time: new Date().toISOString(),
      message,
      service: "ai-colony-messaging",
      ...fields,
    })}\n`,
  );
}
