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
});
