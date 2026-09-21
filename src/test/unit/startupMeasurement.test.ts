import * as assert from 'assert';
import type { Diagnostic } from 'vscode-languageserver/node';
import { diagnosticDigest, median } from '../support/startupMeasurement';

suite('Startup measurement', () => {
  const a: Diagnostic = { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, message: 'a', severity: 1 };
  test('compares complete diagnostics independently of response order', () => {
    const b = { ...a, message: 'b' };
    assert.strictEqual(diagnosticDigest([a, b]), diagnosticDigest([b, a]));
    for (const changed of [{ ...a, message: 'b' }, { ...a, severity: 2 as const }, { ...a, code: 'code' },
      { ...a, data: { reason: 'changed' } }, { ...a, range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } } }]) {
      assert.notStrictEqual(diagnosticDigest([a]), diagnosticDigest([changed]));
    }
    assert.notStrictEqual(diagnosticDigest([a]), diagnosticDigest([a, a]));
    assert.strictEqual(diagnosticDigest([{ ...a, data: { x: 1, y: 2 } }]), diagnosticDigest([{ ...a, data: { y: 2, x: 1 } }]));
  });
  test('computes a median without mutating samples and rejects invalid measurements', () => {
    const values = [40, 20, 30];
    assert.strictEqual(median(values), 30);
    assert.deepStrictEqual(values, [40, 20, 30]);
    assert.strictEqual(median([40, 10]), 25);
    for (const invalid of [[], [NaN], [Infinity]]) { assert.throws(() => median(invalid)); }
  });
});
