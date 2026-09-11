import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import { findLocalDeclaration } from '../../../analyzer/resolution';
import { buildScopeIndex } from '../../../analyzer/scopeIndex';
import { buildSymbolIndex } from '../../../analyzer/symbolIndex';

suite('buildScopeIndex', () => {
  let parser: ReturnType<typeof createAxelParser>;
  setup(() => { parser = createAxelParser(); });
  const uri = 'file:///main.axl';

  test('does not resolve a prototype parameter outside its parameter list', () => {
    const rootNode = parser.parse('int time(int *timer);\nvoid main() { timer; }').rootNode;
    const { declarations } = buildSymbolIndex(rootNode, uri);
    const scopes = buildScopeIndex(rootNode, uri, declarations);
    const analysis = { uri, declarations, scopes };

    assert.strictEqual(findLocalDeclaration(analysis, 'timer', { line: 1, character: 16 }), undefined);
    assert.strictEqual(findLocalDeclaration(analysis, 'time', { line: 1, character: 16 })?.kind, 'function');
  });

  test('keeps class method prototypes in the class scope', () => {
    const rootNode = parser.parse('class VGPathData { void T(); };\nvoid main() { T(); }').rootNode;
    const { declarations } = buildSymbolIndex(rootNode, uri);
    const scopes = buildScopeIndex(rootNode, uri, declarations);
    const analysis = { uri, declarations, scopes };

    assert.strictEqual(findLocalDeclaration(analysis, 'T', { line: 1, character: 14 }), undefined);
    assert.strictEqual(findLocalDeclaration(analysis, 'T', { line: 0, character: 27 })?.containerName, 'VGPathData');
  });

  test('assigns named GUI part declarations to parent scopes', () => {
    const rootNode = parser.parse([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group {',
      '    GCText input;',
      '  };',
      '};'
    ].join('\n')).rootNode;
    const symbols = buildSymbolIndex(rootNode, uri);
    const scopes = buildScopeIndex(rootNode, uri, symbols.declarations);

    const group = symbols.declarations.find((declaration) => declaration.name === 'group');
    const input = symbols.declarations.find((declaration) => declaration.name === 'input');
    assert.ok(group !== undefined);
    assert.ok(input !== undefined);

    const groupScope = scopes.find((scope) => scope.declarationIds.includes(group.id));
    const inputScope = scopes.find((scope) => scope.declarationIds.includes(input.id));
    assert.ok(groupScope !== undefined);
    assert.ok(inputScope !== undefined);
    assert.notDeepStrictEqual(groupScope.range, group.range);
    assert.notStrictEqual(groupScope.id, inputScope.id);
    assert.strictEqual(inputScope.parentId, groupScope.id);
  });
});
