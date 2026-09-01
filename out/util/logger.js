"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullLogger = void 0;
exports.measureDurationMs = measureDurationMs;
exports.NullLogger = {
    info: () => undefined,
    error: () => undefined
};
function measureDurationMs(logger, operation, details, work) {
    const startedAt = Date.now();
    try {
        const result = work();
        logger.info(formatTimingMessage(operation, details, Date.now() - startedAt));
        return result;
    }
    catch (error) {
        logger.error(formatTimingMessage(operation, { ...details, failed: true }, Date.now() - startedAt));
        throw error;
    }
}
function formatTimingMessage(operation, details, durationMs) {
    const detailText = Object.entries({ operation, ...details, durationMs })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ');
    return `[timing] ${detailText}`;
}
//# sourceMappingURL=logger.js.map