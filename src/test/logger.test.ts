import * as assert from 'assert';
import { measureDurationMs, NullLogger, type AnalysisLogger } from '../util/logger';

suite('logger utilities', () => {
  test('measureDurationMs logs timing details from successful work', () => {
    const entries: string[] = [];
    const logger: AnalysisLogger = {
      info: (message) => entries.push(message),
      error: () => undefined
    };

    const result = measureDurationMs(logger, 'workspace.foreground', { uri: 'file:///main.axl' }, () => 42);

    assert.strictEqual(result, 42);
    assert.strictEqual(entries.length, 1);
    assert.match(entries[0], /workspace\.foreground/);
    assert.match(entries[0], /uri=file:\/\/\/main\.axl/);
    assert.match(entries[0], /durationMs=\d+/);
  });

  test('measureDurationMs logs failed work before rethrowing', () => {
    const entries: string[] = [];
    const logger: AnalysisLogger = {
      info: () => undefined,
      error: (message) => entries.push(message)
    };

    assert.throws(() => measureDurationMs(logger, 'workspace.foreground', {}, () => {
      throw new Error('broken');
    }), /broken/);
    assert.strictEqual(entries.length, 1);
    assert.match(entries[0], /workspace\.foreground/);
    assert.match(entries[0], /failed=true/);
    assert.match(entries[0], /durationMs=\d+/);
  });

  test('NullLogger ignores timing messages', () => {
    assert.doesNotThrow(() => {
      measureDurationMs(NullLogger, 'workspace.foreground', {}, () => undefined);
    });
  });
});
