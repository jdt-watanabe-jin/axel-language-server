import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver/node';
import { ProjectScope } from '../../analyzer/projectScope';
import { TypeHierarchyIndex } from '../../analyzer/typeHierarchy/index';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Type hierarchy performance', function () {
  this.timeout(30_000);
  const { createTempDir } = useWorkspaceFixtures();
  const token = CancellationToken.None;
  test('fingerprints repeated diamonds without exponential ancestor expansion', async () => {
    const directory = createTempDir();
    const file = path.join(directory, 'diamond.axl');
    const uri = pathToFileURL(file).toString();
    const lines = ['class A0 { int x; }; class B0 { int y; };'];
    for (let i = 1; i <= 18; i++) {
      lines.push(`class A${i} : A${i - 1}, B${i - 1} { int x; }; class B${i} : A${i - 1}, B${i - 1} { int y; };`);
    }
    const text = lines.join('\n'); fs.writeFileSync(file, text);
    const scope = new ProjectScope(); scope.setRoots([pathToFileURL(directory).toString()]);
    const index = new TypeHierarchyIndex(scope, () => [{ uri, version: 1, text }]);
    try {
      index.resume();
      const item = (await index.prepare(uri, { line: 18, character: 6 }, token))![0];
      const start = performance.now();
      assert.deepStrictEqual(await index.subtypes(item.data, token), []);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 1000, `38-class diamond graph took ${elapsed.toFixed(0)}ms`);
    } finally { await index.dispose(); }
  });

});
