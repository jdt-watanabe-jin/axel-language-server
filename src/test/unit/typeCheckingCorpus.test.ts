import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisDiagnostic } from '../../types/analysis';
import { assertCaseDiagnostics, loadTypeCheckingCases, typeCheckingFixtureRoot } from '../support/typeCheckingCorpus';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Type checking: corpus', () => {
  const fixtures = useWorkspaceFixtures();
  function alteredManifest(change: (cases: Record<string, unknown>[]) => void): string {
    const root = fixtures.createTempDir();
    const manifest = JSON.parse(fs.readFileSync(path.join(typeCheckingFixtureRoot, 'manifest.json'), 'utf8'));
    fs.cpSync(typeCheckingFixtureRoot, root, { recursive: true });
    change(manifest.cases);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    return root;
  }
  test('preserves all measured cases, compiler codes, and source hashes', () => {
    const cases = loadTypeCheckingCases();
    assert.strictEqual(cases.length, 157);
    assert.strictEqual(new Set(cases.map(c => c.id)).size, 157);
    assert.strictEqual(cases.filter(c => c.id.startsWith('initial/')).length, 44);
    assert.strictEqual(cases.filter(c => c.id.startsWith('round2/')).length, 113);
    assert.strictEqual(cases.filter(c => c.expectedError === true).length, 71);
    assert.strictEqual(cases.filter(c => c.expectedError === false).length, 85);
    assert.deepStrictEqual(cases.filter(c => c.expectedError === null).map(c => c.id), ['round2/sizeof_bad_expr']);
    assert.strictEqual(cases.find(c => c.id === 'round2/return_int_empty')?.expectedError, true);
    assert.deepStrictEqual(cases.find(c => c.id === 'round2/return_int_empty')?.compilerCodes, ['C47']);
    assert.deepStrictEqual(cases.find(c => c.id === 'round2/delete_int')?.compilerCodes, ['C73']);
    assert.strictEqual(cases.find(c => c.id === 'round2/type_nat_div')?.category, 'initialization');
  });
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
  test('rejects duplicate IDs', () => {
    const root = alteredManifest(cases => cases.push(cases[0]));
    assert.throws(() => loadTypeCheckingCases(root), /Duplicate case ID/);
  });
  test('rejects a missing source', () => {
    const root = alteredManifest(() => {});
    fs.unlinkSync(path.join(root, 'initial/baseline.axl'));
    assert.throws(() => loadTypeCheckingCases(root), /ENOENT/);
  });
  test('rejects invalid expectations', () => {
    const root = alteredManifest(cases => { cases[0].expectedError = 'false'; });
    assert.throws(() => loadTypeCheckingCases(root), /Invalid expectation/);
  });
  test('rejects source modifications', () => {
    const root = alteredManifest(() => {});
    fs.appendFileSync(path.join(root, 'initial/baseline.axl'), ' ');
    assert.throws(() => loadTypeCheckingCases(root), /Source hash mismatch/);
  });
  test('rejects errors without a primary category or source range', () => {
    const root = alteredManifest(cases => { delete cases[1].category; });
    assert.throws(() => loadTypeCheckingCases(root), /Missing primary category/);
    const missingRange = alteredManifest(cases => { delete cases[1].expectedRange; });
    assert.throws(() => loadTypeCheckingCases(missingRange), /Invalid error range/);
  });
});
