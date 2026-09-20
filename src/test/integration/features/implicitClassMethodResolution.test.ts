import * as assert from 'assert';
import { collectSemanticDiagnostics } from '../../../analyzer/semanticDiagnostics';
import { getHover } from '../../../analyzer/hover';
import { getDefinitions } from '../../../analyzer/navigation';
import { analyzeMarked } from '../../support/source';

suite('Implicit class method resolution', () => {
  const own = 'int Version::compare(Version v) { return 0; }';
  const unrelated = [
    'static int VersionComparator::compare(Version lhs, Version rhs) { return 0; }',
    'static int VersionComparator::compare(Version lhs, Version rhs, int option) { return 0; }'
  ].join('\n');
  for (const reversed of [false, true]) {
    for (const external of [false, true]) {
      test(`resolves the owning method (reversed=${reversed}, external=${external})`, () => {
        const body = 'bool operator==(Version v) { return com|pare(v) == 0; }';
        const input = analyzeMarked([
          external ? 'class Version {};\nbool Version::equal(Version v) { return com|pare(v) == 0; }'
            : `class Version { ${body} };`,
          'class VersionComparator {};',
          ...(reversed ? [unrelated, own] : [own, unrelated])
        ].join('\n'));
        assert.deepStrictEqual(collectSemanticDiagnostics(input), []);
        assert.ok(getHover({ ...input, workspaceIndex: {} })?.plainText.includes('int Version::compare(Version v)'));
        const target = input.analysis.declarations.find(d => d.name === 'compare' && d.containerName === 'Version')!;
        assert.deepStrictEqual(getDefinitions({ ...input, workspaceIndex: {} }), [{ uri: target.uri, range: target.selectionRange }]);
      });
    }
  }
  test('rejects an arity matching only an unrelated class', () => {
    const input = analyzeMarked([
      'class Version { bool equal(Version v) { return com|pare(v, v) == 0; } };',
      'class VersionComparator {};', own, unrelated
    ].join('\n'));
    const errors = collectSemanticDiagnostics(input).filter(d => d.message.includes('expects'));
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('expects 1 argument'));
  });
  test('prefers an external derived method over an earlier base method', () => {
    const input = analyzeMarked([
      'class Base { int compare(int x, int y) { return 0; } };',
      'class Version : Base { bool test() { return com|pare(1) == 0; } };',
      'int Version::compare(int x) { return 0; }'
    ].join('\n'));
    assert.deepStrictEqual(collectSemanticDiagnostics(input), []);
    const target = input.analysis.declarations.find(d => d.name === 'compare' && d.containerName === 'Version')!;
    assert.deepStrictEqual(getDefinitions({ ...input, workspaceIndex: {} }), [{ uri: target.uri, range: target.selectionRange }]);
  });
  test('preserves a local variable shadowing the method', () => {
    const input = analyzeMarked('class Version { void test() { int compare; com|pare; } };\n' + own);
    assert.ok(getHover({ ...input, workspaceIndex: {} })?.plainText.includes('int compare'));
  });
});
