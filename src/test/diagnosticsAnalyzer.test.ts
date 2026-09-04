import * as assert from 'assert';
import { createAxelParser } from '../analyzer/axelParser';
import { collectSyntaxDiagnostics } from '../analyzer/diagnostics';

suite('collectSyntaxDiagnostics', () => {
  test('returns no diagnostics for valid AXEL', () => {
    const parser = createAxelParser();
    const tree = parser.parse('void main() {}');

    assert.deepStrictEqual(collectSyntaxDiagnostics(tree.rootNode), []);
  });

  test('does not report missing identifiers for class anonymous enums', () => {
    const parser = createAxelParser();
    const tree = parser.parse(`
class Json {
  enum {
    COMPACT,
    INDENT,
  };
};
`);

    assert.deepStrictEqual(collectSyntaxDiagnostics(tree.rootNode), []);
  });

  test('reports parser ERROR nodes as syntax errors', () => {
    const parser = createAxelParser();
    const tree = parser.parse('void main( {');
    const diagnostics = collectSyntaxDiagnostics(tree.rootNode);

    assert.ok(diagnostics.length > 0);
    assert.strictEqual(diagnostics[0].severity, 'error');
    assert.strictEqual(diagnostics[0].source, 'axel');
    assert.strictEqual(diagnostics[0].message, 'Syntax error.');
  });

  test('suppresses syntax error for valid class body macro expansion', () => {
    const parser = createAxelParser();
    const tree = parser.parse('class C { DEFINE_FIELD(int) };');

    const diagnostics = collectSyntaxDiagnostics(tree.rootNode, {
      uri: 'file:///main.axl',
      macroDefinitions: [{
        name: 'DEFINE_FIELD',
        uri: 'file:///macros.h',
        range: zeroRange(),
        selectionRange: zeroRange(),
        detail: '#define DEFINE_FIELD(T) T value;',
        parameters: [{ label: 'T' }],
        replacementText: 'T value;'
      }],
      parseText: (text) => parser.parse(text).rootNode
    });

    assert.deepStrictEqual(diagnostics, []);
  });

  test('keeps syntax error for unknown class body macro expansion', () => {
    const parser = createAxelParser();
    const tree = parser.parse('class C { UNKNOWN(int) };');

    const diagnostics = collectSyntaxDiagnostics(tree.rootNode, {
      uri: 'file:///main.axl',
      macroDefinitions: [],
      parseText: (text) => parser.parse(text).rootNode
    });

    assert.strictEqual(diagnostics[0]?.message, 'Syntax error.');
  });

  test('keeps syntax error when macro arity does not match', () => {
    const parser = createAxelParser();
    const tree = parser.parse('class C { DEFINE_FIELD(int, string) };');

    const diagnostics = collectSyntaxDiagnostics(tree.rootNode, {
      uri: 'file:///main.axl',
      macroDefinitions: [{
        name: 'DEFINE_FIELD',
        uri: 'file:///macros.h',
        range: zeroRange(),
        selectionRange: zeroRange(),
        detail: '#define DEFINE_FIELD(T) T value;',
        parameters: [{ label: 'T' }],
        replacementText: 'T value;'
      }],
      parseText: (text) => parser.parse(text).rootNode
    });

    assert.strictEqual(diagnostics[0]?.message, 'Syntax error.');
  });

  test('keeps syntax error when expanded class body code is invalid', () => {
    const parser = createAxelParser();
    const tree = parser.parse('class C { BROKEN(int) };');

    const diagnostics = collectSyntaxDiagnostics(tree.rootNode, {
      uri: 'file:///main.axl',
      macroDefinitions: [{
        name: 'BROKEN',
        uri: 'file:///macros.h',
        range: zeroRange(),
        selectionRange: zeroRange(),
        detail: '#define BROKEN(T) T',
        parameters: [{ label: 'T' }],
        replacementText: 'T'
      }],
      parseText: (text) => parser.parse(text).rootNode
    });

    assert.strictEqual(diagnostics[0]?.message, 'Syntax error.');
  });
});

function zeroRange() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  };
}
