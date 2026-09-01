export interface AnalysisLogger {
  info(message: string): void;
  error(message: string): void;
}

export const NullLogger: AnalysisLogger = {
  info: () => undefined,
  error: () => undefined
};

export function measureDurationMs<T>(
  logger: AnalysisLogger,
  operation: string,
  details: Record<string, string | number | boolean | undefined>,
  work: () => T
): T {
  const startedAt = Date.now();
  try {
    const result = work();
    logger.info(formatTimingMessage(operation, details, Date.now() - startedAt));
    return result;
  } catch (error: unknown) {
    logger.error(formatTimingMessage(operation, { ...details, failed: true }, Date.now() - startedAt));
    throw error;
  }
}

function formatTimingMessage(
  operation: string,
  details: Record<string, string | number | boolean | undefined>,
  durationMs: number
): string {
  const detailText = Object.entries({ operation, ...details, durationMs })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return `[timing] ${detailText}`;
}
