import * as assert from 'assert';
import { toLspDiagnostic } from '../../../lsp/diagnostics';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Type checking: missing member diagnostics', () => {
  const fixtures = useWorkspaceFixtures();
  function check(text: string) {
    return fixtures.createWorkspaceIndex().analyzeDocument({uri: 'file:///members.axl', version: 1, text})
      .diagnostics.filter(d => d.code?.startsWith('axel.type.'));
  }

  test('names the missing method and receiver type in English and Japanese', () => {
    const diagnostics = check('class DMLibraryDD { int x; };\nvoid f(DMLibraryDD ldd){ ldd.GetDBID(); }');
    assert.strictEqual(diagnostics.length, 1);
    const en = toLspDiagnostic(diagnostics[0], 'en');
    const ja = toLspDiagnostic(diagnostics[0], 'ja-JP');
    assert.strictEqual(en.message, "Member 'GetDBID' was not found on type 'DMLibraryDD'.");
    assert.strictEqual(ja.message, "型 'DMLibraryDD' にメンバー 'GetDBID' が見つかりません。");
    assert.deepStrictEqual({...ja, message: en.message}, en);
    assert.strictEqual(en.code, 'axel.type.member');
    assert.strictEqual(en.severity, 1);
    assert.deepStrictEqual(en.range, {start: {line: 1, character: 29}, end: {line: 1, character: 36}});
  });

  test('names missing data members accessed through pointers', () => {
    const diagnostics = check('class Item { int x; }; void f(Item *item){ item->missing; }');
    assert.deepStrictEqual(diagnostics.map(d => d.message), ["Member 'missing' was not found on type 'Item'."]);
  });

  test('continues to resolve inherited members', () => {
    assert.deepStrictEqual(check('class Base { int x; int GetDBID(){return 1;} }; class DMLibraryDD : public Base {}; void f(DMLibraryDD ldd){ ldd.GetDBID(); ldd.x; }'), []);
  });
});
