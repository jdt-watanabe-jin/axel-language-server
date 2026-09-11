import * as assert from 'assert';
import type { AnalysisDiagnostic } from '../../types/analysis';
import { assertCaseDiagnostics, loadTypeCheckingCases } from '../support/typeCheckingCorpus';

suite('Type checking: corpus', () => {

  test('requires the primary cause on the recorded source line', () => {
    const runtimeCase = loadTypeCheckingCases().find(c => c.id === 'round2/type_nat_div')!;
    const diagnostic: AnalysisDiagnostic & { code: string } = {
      severity: 'error', source: 'axel', message: 'test', code: 'axel.type.initialization',
      range: runtimeCase.expectedRange!
    };
    assert.doesNotThrow(() => assertCaseDiagnostics(runtimeCase, [diagnostic]));
    assert.throws(() => assertCaseDiagnostics(runtimeCase, [{ ...diagnostic, code: 'axel.type.binary_operator' } as AnalysisDiagnostic]), /expected initialization/);
    assert.throws(() => assertCaseDiagnostics(runtimeCase, [{ ...diagnostic,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    }]), /expected initialization/);
    assert.throws(() => assertCaseDiagnostics(runtimeCase, []), /expected initialization/);
    const accepted = loadTypeCheckingCases()[0];
    assert.throws(() => assertCaseDiagnostics(accepted, [diagnostic]), /unexpected errors/);
  });
});
