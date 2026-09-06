import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import { collectSyntaxDiagnostics } from '../../../analyzer/diagnostics';

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

  for (const scriptPath of ['/home/path/to/sub.axl', 'C:\\path\\to\\sub.axl']) {
    test(`accepts an absolute command path: ${scriptPath}`, () => {
      const parser = createAxelParser();
      const tree = parser.parse(`void main() { @${scriptPath}; }`);

      assert.deepStrictEqual(collectSyntaxDiagnostics(tree.rootNode), []);
    });
  }
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

  test('reports macro arity diagnostics for known malformed invocations', () => {
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

    assert.deepStrictEqual(diagnostics, [{
      severity: 'error',
      source: 'axel',
      message: "Macro 'DEFINE_FIELD' expects 1 argument but got 2.",
      range: {
        start: { line: 0, character: 10 },
        end: { line: 0, character: 35 }
      }
    }]);
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
