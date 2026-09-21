import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { setImmediate } from 'timers/promises';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { createAxelParser } from '../../analyzer/axelParser';
import type { AnalyzedDocument } from '../../types/analysis';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Analysis lifetime', () => {
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
  test('reopens twenty generations at the same version without retaining stale results', async () => {
    const root = createTempDir();
    const index = createWorkspaceIndex({ sxmHome: root, includeRoots: [root] });
    const uri = pathToFileURL(path.join(root, 'lifetime.axl')).toString();
    const parser = createAxelParser();
    const parse = parser.parse.bind(parser);
    const trees: WeakRef<ReturnType<typeof parse>>[] = [];
    parser.parse = (...args) => {
      const tree = parse(...args);
      trees.push(new WeakRef(tree));
      return tree;
    };
    const analyzer = new DocumentAnalyzer(parser);
    const previous: WeakRef<AnalyzedDocument>[] = [];
    const heaps: number[] = [];
    function generation(version: number) {
      const text = Array.from({ length: 300 }, (_, i) => `int value_${version}_${i};`).join('\n');
      const input = { uri, version: 0, text };
      index.updateOpenDocument(input);
      const result = index.indexOpenDocument(input);
      assert.deepStrictEqual(result.declarations, new DocumentAnalyzer().analyzeDocument(input).declarations);
      assert.deepStrictEqual(analyzer.analyzeDocument(input), new DocumentAnalyzer().analyzeDocument(input));
      previous.push(new WeakRef(result));
      index.deleteDocument(uri);
      analyzer.clear(uri);
    }
    for (let version = 0; version < 20; version++) {
      generation(version);
      await index.waitForBackgroundIndexing();
      await setImmediate();
      if (global.gc) {
        global.gc();
        heaps.push(process.memoryUsage().heapUsed);
      }
    }
    if (global.gc) {
      await setImmediate();
      global.gc();
      // GC scheduling is not a CI contract. Inspect this evidence in the optional fresh-process run.
      console.log(JSON.stringify({ retainedAnalyses: previous.filter(ref => ref.deref()).length,
        retainedTrees: trees.filter(ref => ref.deref()).length, heaps }));
    }
  }).timeout(30000);
});
