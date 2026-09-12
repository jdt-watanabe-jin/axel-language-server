import * as assert from 'assert';
import { useWorkspaceFixtures } from '../../support/workspace';
import { formatMessage } from '../../../i18n/messages';

suite('Missing qualified member diagnostics', () => {
  const fixtures = useWorkspaceFixtures();
  function check(text: string) {
    return fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///qualified.axl', version:1, text}).diagnostics;
  }
  test('reports the owning class and missing member', () => {
    const ds = check('class DBCellDD { int x; }; void f(){ DBCellDD::IsLocked(); }');
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].message, "Member 'IsLocked' was not found on type 'DBCellDD'.");
    assert.strictEqual(ds[0].severity, 'error');
    assert.ok(formatMessage(ds[0].messageDescriptor!, 'ja').includes('DBCellDD'));
  });
  test('accepts an existing static member', () => {
    assert.deepStrictEqual(check('class DBCellDD { int x; static int IsLocked(){ return 0; } }; void f(){ DBCellDD::IsLocked(); }'), []);
  });
  test('retains the unknown identifier diagnostic for unqualified names', () => {
    assert.ok(check('void f(){ IsLocked(); }').some(d => d.message === "Unknown identifier 'IsLocked'."));
  });
});
