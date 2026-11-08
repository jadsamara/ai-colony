export interface ToleranceSpec {
  /** Absolute allowed error |actual - expected|. */
  absolute?: number;
  /** Relative allowed error |actual - expected| / max(|expected|, 1e-12). */
  relative?: number;
}

export interface ToleranceCheck {
  ok: boolean;
  absoluteError: number;
  relativeError: number;
  absoluteLimit: number | null;
  relativeLimit: number | null;
  reason: string;
}

export function withinTolerance(actual: number, expected: number, tolerance: ToleranceSpec): ToleranceCheck {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    return {
      ok: false,
      absoluteError: Number.NaN,
      relativeError: Number.NaN,
      absoluteLimit: tolerance.absolute ?? null,
      relativeLimit: tolerance.relative ?? null,
      reason: "actual or expected is not finite",
    };
  }
  const absoluteError = Math.abs(actual - expected);
  const relativeError = absoluteError / Math.max(Math.abs(expected), 1e-12);
  const absoluteLimit = tolerance.absolute;
  const relativeLimit = tolerance.relative;
  if (absoluteLimit === undefined && relativeLimit === undefined) {
    return {
      ok: false,
      absoluteError,
      relativeError,
      absoluteLimit: null,
      relativeLimit: null,
      reason: "tolerance must specify absolute and/or relative limits",
    };
  }
  if (absoluteLimit !== undefined && (!Number.isFinite(absoluteLimit) || absoluteLimit < 0)) {
    return {
      ok: false,
      absoluteError,
      relativeError,
      absoluteLimit,
      relativeLimit: relativeLimit ?? null,
      reason: "absolute tolerance is invalid",
    };
  }
  if (relativeLimit !== undefined && (!Number.isFinite(relativeLimit) || relativeLimit < 0)) {
    return {
      ok: false,
      absoluteError,
      relativeError,
      absoluteLimit: absoluteLimit ?? null,
      relativeLimit,
      reason: "relative tolerance is invalid",
    };
  }
  const absoluteOk = absoluteLimit === undefined ? true : absoluteError <= absoluteLimit;
  const relativeOk = relativeLimit === undefined ? true : relativeError <= relativeLimit;
  const ok = absoluteOk && relativeOk;
  return {
    ok,
    absoluteError,
    relativeError,
    absoluteLimit: absoluteLimit ?? null,
    relativeLimit: relativeLimit ?? null,
    reason: ok
      ? "within tolerance"
      : `outside tolerance (abs=${absoluteError}, rel=${relativeError})`,
  };
}
