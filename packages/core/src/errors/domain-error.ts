export class DomainError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function notFound(entity: string, id?: string): DomainError {
  const suffix = id ? ` ${id}` : "";
  return new DomainError("NOT_FOUND", `${entity}${suffix} was not found`, 404);
}
