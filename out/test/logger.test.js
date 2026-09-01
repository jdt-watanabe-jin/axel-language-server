"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const logger_1 = require("../util/logger");
suite('logger utilities', () => {
    test('measureDurationMs logs timing details from successful work', () => {
        const entries = [];
        const logger = {
            info: (message) => entries.push(message),
            error: () => undefined
        };
        const result = (0, logger_1.measureDurationMs)(logger, 'workspace.foreground', { uri: 'file:///main.axl' }, () => 42);
        assert.strictEqual(result, 42);
        assert.strictEqual(entries.length, 1);
        assert.match(entries[0], /workspace\.foreground/);
        assert.match(entries[0], /uri=file:\/\/\/main\.axl/);
        assert.match(entries[0], /durationMs=\d+/);
    });
    test('measureDurationMs logs failed work before rethrowing', () => {
        const entries = [];
        const logger = {
            info: () => undefined,
            error: (message) => entries.push(message)
        };
        assert.throws(() => (0, logger_1.measureDurationMs)(logger, 'workspace.foreground', {}, () => {
            throw new Error('broken');
        }), /broken/);
        assert.strictEqual(entries.length, 1);
        assert.match(entries[0], /workspace\.foreground/);
        assert.match(entries[0], /failed=true/);
        assert.match(entries[0], /durationMs=\d+/);
    });
    test('NullLogger ignores timing messages', () => {
        assert.doesNotThrow(() => {
            (0, logger_1.measureDurationMs)(logger_1.NullLogger, 'workspace.foreground', {}, () => undefined);
        });
    });
});
//# sourceMappingURL=logger.test.js.map