import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { mock } from 'node:test';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { ProjectScope } from '../../analyzer/projectScope';
import { TypeHierarchyIndex } from '../../analyzer/typeHierarchy/index';
import * as semantics from '../../analyzer/typeHierarchy/semantics';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Type hierarchy performance', function () {
  this.timeout(30_000);
  const { createTempDir } = useWorkspaceFixtures();
  const token = CancellationToken.None;
  test('reuses unchanged contexts and updates only an edited independent source', async () => {
    const directory = createTempDir();
    const uri = (name: string) => pathToFileURL(path.join(directory, name)).toString();
    const text = 'class Base { int x; };';
    fs.writeFileSync(path.join(directory, 'base.h'), text);
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(directory, `child${i}.axl`), `#include "base.h"\nclass Child${i} : Base { int x; };`);
    }
    const scope = new ProjectScope(); scope.setRoots([uri('')]);
    const index = new TypeHierarchyIndex(scope, () => [{ uri: uri('base.h'), version: 1, text }]);
    const collect = semantics.collectTypeHierarchy; let count = 0;
    const spy = mock.method(semantics, 'collectTypeHierarchy', (...args: Parameters<typeof collect>) => { count++; return collect(...args); });
    try {
      index.resume();
      const base = (await index.prepare(uri('base.h'), { line: 0, character: 6 }, token))![0];
      const start = performance.now();
      assert.strictEqual((await index.subtypes(base.data, token))?.length, 100);
      const initial = performance.now() - start;
      count = 0;
      assert.strictEqual((await index.subtypes(base.data, token))?.length, 100);
      assert.strictEqual(count, 0, 'unchanged sources were reparsed');
      fs.writeFileSync(path.join(directory, 'child0.axl'), '#include "base.h"\nclass Replaced : Base { int x; };');
      index.invalidate([uri('child0.axl')]);
      const children = await index.subtypes(base.data, token);
      assert.ok(children?.some(item => item.name === 'Replaced'));
      assert.strictEqual(count, 1, 'an independent edit reparsed unrelated sources');
      console.log(`    Type hierarchy: 100 derived files, initial=${initial.toFixed(0)}ms`);
    } finally { await index.dispose(); spy.mock.restore(); }
  });

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

  test('cancels a waiter without cancelling shared indexing', async () => {
    const directory = createTempDir();
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const text = 'class A { int x; }; class B : A { int y; };';
    const scope = new ProjectScope(); scope.setRoots([pathToFileURL(directory).toString()]);
    const index = new TypeHierarchyIndex(scope, () => [{ uri, version: 1, text }]);
    const source = new CancellationTokenSource();
    try {
      index.resume();
      const item = (await index.prepare(uri, { line: 0, character: 6 }, token))![0];
      const request = index.subtypes(item.data, source.token); source.cancel();
      await assert.rejects(request, (error: { code?: number }) => error.code === LSPErrorCodes.RequestCancelled);
      assert.deepStrictEqual((await index.subtypes(item.data, token))?.map(item => item.name), ['B']);
    } finally { source.dispose(); await index.dispose(); }
  });
});
