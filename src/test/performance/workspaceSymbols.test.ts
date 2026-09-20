import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { performance } from 'perf_hooks';
import { mock } from 'node:test';
import { CancellationToken } from 'vscode-languageserver/node';
import * as extraction from '../../analyzer/workspaceSymbols/extract';
import { WorkspaceSymbolIndex } from '../../analyzer/workspaceSymbols/index';
import { useWorkspaceFixtures } from '../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
suite('Workspace Symbol performance', function () {
  this.timeout(30000);
  test('indexes a large fixture once and updates only a changed file', async () => {
    const root = createTempDir();
    for (let file = 0; file < 500; file++) {
      fs.writeFileSync(path.join(root, `${file}.axl`), Array.from({ length: 20 }, (_, member) => `int item${file}_${member};`).join('\n'));
    }
    const index = new WorkspaceSymbolIndex(error => assert.fail(error));
    const extract = extraction.extractWorkspaceSymbols; let parsed = 0;
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof extract>) => { parsed++; return extract(...args); });
    const memory = process.memoryUsage().heapUsed;
    try {
      index.setRoots([pathToFileURL(root).toString()]);
      const start = performance.now();
      assert.strictEqual((await index.search('', CancellationToken.None)).length, 10000);
      const initial = performance.now() - start;
      assert.strictEqual(parsed, 500); parsed = 0;
      const repeatStart = performance.now();
      assert.strictEqual((await index.search('item', CancellationToken.None)).length, 10000);
      const repeat = performance.now() - repeatStart;
      assert.strictEqual(parsed, 0);
      fs.writeFileSync(path.join(root, '0.axl'), 'int replaced;');
      assert.strictEqual((await index.search('replaced', CancellationToken.None)).length, 1);
      assert.strictEqual(parsed, 1);
      console.log(`Workspace Symbol: 500 files / 10000 symbols, initial=${initial.toFixed(0)}ms repeat=${repeat.toFixed(0)}ms heapDelta=${process.memoryUsage().heapUsed - memory}`);
    } finally { await index.dispose(); spy.mock.restore(); }
  });
});
