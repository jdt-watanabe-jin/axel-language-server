import * as assert from 'assert';
import type { AnalysisDiagnostic } from '../../types/analysis';
import { assertCaseDiagnostics, type RuntimeCase } from '../support/typeCheckingCorpus';

suite('Type checking: corpus', () => {

  test('requires the primary cause on the recorded source line', () => {
    const runtimeCase: RuntimeCase = {
      id: 'round2/type_nat_div', source: '\n\nint value = naturalValue / 2;', expectedError: true,
      category: 'initialization', compilerCodes: ['C100'], evidenceId: 'matcher-fixture',
      expectedRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }
    };
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
    const accepted: RuntimeCase = { id: 'initial/baseline', source: '', expectedError: false, compilerCodes: [], evidenceId: 'matcher-fixture' };
    assert.throws(() => assertCaseDiagnostics(accepted, [diagnostic]), /unexpected errors/);
  });
});
