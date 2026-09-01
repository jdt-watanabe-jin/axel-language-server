import * as assert from 'assert';
import { createAxelParser } from '../analyzer/axelParser';
import { buildScopeIndex } from '../analyzer/scopeIndex';
import { buildSymbolIndex } from '../analyzer/symbolIndex';

suite('buildScopeIndex', () => {
  const parser = createAxelParser();
  const uri = 'file:///main.axl';

  test('always creates a global scope covering the root node', () => {
    const rootNode = parser.parse('void main() {}').rootNode;
    const symbols = buildSymbolIndex(rootNode, uri);
    const scopes = buildScopeIndex(rootNode, uri, symbols.declarations);

    assert.deepStrictEqual(scopes[0], {
      id: 'file:///main.axl#scope:global',
      parentId: undefined,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 14 }
      },
      declarationIds: ['file:///main.axl#0:5:main']
    });
  });

  test('creates class and function container scopes for nested declarations', () => {
    const rootNode = parser.parse('class Widget { int value; void update() { int local; } };').rootNode;
    const symbols = buildSymbolIndex(rootNode, uri);
    const scopes = buildScopeIndex(rootNode, uri, symbols.declarations);

    assert.strictEqual(scopes.length, 4);
    assert.deepStrictEqual(scopes.map((scope) => scope.declarationIds), [
      ['file:///main.axl#0:6:Widget'],
      ['file:///main.axl#0:19:value', 'file:///main.axl#0:31:update'],
      [],
      ['file:///main.axl#0:46:local']
    ]);
  });

  test('assigns function parameters to a scope enclosing the function body', () => {
    const rootNode = parser.parse('void update(int count) { count = 1; }').rootNode;
    const symbols = buildSymbolIndex(rootNode, uri);
    const scopes = buildScopeIndex(rootNode, uri, symbols.declarations);

    const parameter = symbols.declarations.find((declaration) => declaration.name === 'count');
    assert.ok(parameter !== undefined);
    assert.ok(scopes.some((scope) => scope.declarationIds.includes(parameter.id)));
  });

  test('creates scopes for GUI part containers', () => {
    const rootNode = parser.parse([
      'class MyDialog : public GCDialog {',
      '  GCVBoxLayout {',
      '    GCText input;',
      '  };',
      '};'
    ].join('\n')).rootNode;
    const symbols = buildSymbolIndex(rootNode, uri);
    const scopes = buildScopeIndex(rootNode, uri, symbols.declarations);

    const input = symbols.declarations.find((declaration) => declaration.name === 'input');
    assert.ok(input !== undefined);
    assert.ok(scopes.some((scope) => scope.declarationIds.includes(input.id)));
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
