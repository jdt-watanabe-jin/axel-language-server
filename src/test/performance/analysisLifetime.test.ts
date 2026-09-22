import * as assert from 'assert';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { visibleDeclarationsByName } from '../../analyzer/resolution';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Analysis lifetime', () => {
  const { createWorkspaceIndex } = useWorkspaceFixtures();
  test('reopens the same URI and version without stale symbols or types', async () => {
    const index = createWorkspaceIndex();
    const analyzer = new DocumentAnalyzer();
    const uri = 'file:///lifetime.axl';
    for (const [name, type, previous] of [['first', 'int', ''], ['second', 'string', 'first'], ['third', 'double', 'second']]) {
      const input = { uri, version: 0, text: type + ' ' + name + ';' };
      index.updateOpenDocument(input);
      const analysis = index.indexOpenDocument(input);
      const direct = analyzer.analyzeDocument(input);
      for (const result of [analysis, direct]) {
        assert.deepStrictEqual(result.declarations.map(d => [d.name, d.typeName]), [[name, type]]);
      }
      const lookup = { analysis, position: { line: 0, character: 0 }, workspaceIndex: index };
      assert.strictEqual(visibleDeclarationsByName(lookup, name).length, 1);
      if (previous) { assert.deepStrictEqual(visibleDeclarationsByName(lookup, previous), []); }
      index.deleteDocument(uri); analyzer.clear(uri);
      await index.waitForBackgroundIndexing();
    }
  });
});
