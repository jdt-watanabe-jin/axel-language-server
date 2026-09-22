import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
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
  for (const request of ['subtypes', 'implementation'] as const) {
    test(`defers project traversal until the first ${request} request and resumes updates afterwards`, async () => {
      const directory = createTempDir();
      const uri = (name: string) => pathToFileURL(path.join(directory, name)).toString();
      const text = 'class Base { int x; };';
      fs.writeFileSync(path.join(directory, 'base.h'), text);
      fs.writeFileSync(path.join(directory, 'child.axl'), '#include "base.h"\nclass Child : Base { int y; };');
      const scope = new ProjectScope(); scope.setRoots([uri('')]);
      const collect = scope.collect.bind(scope);
      const traversal = mock.method(scope, 'collect', (...args: Parameters<typeof collect>) => collect(...args));
      const index = new TypeHierarchyIndex(scope, () => [{ uri: uri('base.h'), version: 1, text }]);
      try {
        index.resume();
        index.invalidate([uri('child.axl')]);
        index.pause(); index.configure({ tool: 'asca' }); index.resume();
        assert.strictEqual(traversal.mock.callCount(), 0, 'startup and lifecycle changes must not traverse the project');
        const base = (await index.prepare(uri('base.h'), { line: 0, character: 6 }, token))![0];
        assert.deepStrictEqual(await index.supertypes(base.data, token), []);
        const cancelled = new CancellationTokenSource(); cancelled.cancel();
        try {
          await assert.rejects(index.subtypes(base.data, cancelled.token),
            (error: { code?: number }) => error.code === LSPErrorCodes.RequestCancelled);
        } finally { cancelled.dispose(); }
        assert.strictEqual(traversal.mock.callCount(), 0, 'local navigation and cancelled requests must not start project indexing');
        if (request === 'subtypes') {
          assert.deepStrictEqual((await index.subtypes(base.data, token))?.map(item => item.name), ['Child']);
        } else {
          assert.deepStrictEqual((await index.navigate('implementation', uri('base.h'), { line: 0, character: 6 }, token))
            .map(item => fs.realpathSync.native(fileURLToPath(item.uri))), [fs.realpathSync.native(path.join(directory, 'child.axl'))]);
        }
        const previous = traversal.mock.callCount();
        assert.ok(previous > 0);
        fs.writeFileSync(path.join(directory, 'child.axl'), '#include "base.h"\nclass Changed : Base { int y; };');
        index.invalidate([uri('child.axl')]);
        assert.ok(traversal.mock.callCount() > previous, 'after first use, edits must refresh shared indexing');
        assert.deepStrictEqual((await index.subtypes(base.data, token))?.map(item => item.name), ['Changed']);
        index.pause();
        index.configure({ tool: 'asca', defines: [{ name: 'UPDATED', value: '1' }] });
        const paused = traversal.mock.callCount();
        index.resume();
        assert.ok(traversal.mock.callCount() > paused, 'pause/configure/resume must retain activation after first use');
        assert.deepStrictEqual((await index.subtypes(base.data, token))?.map(item => item.name), ['Changed']);
      } finally { await index.dispose(); traversal.mock.restore(); }
    });
  }
  test('reuses unchanged contexts and updates only an edited independent source', async () => {
    const directory = createTempDir();
    const uri = (name: string) => pathToFileURL(path.join(directory, name)).toString();
    const text = 'class Base { int x; };';
    fs.writeFileSync(path.join(directory, 'base.h'), text);
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(directory, `child${i}.axl`), `#include "base.h"\nclass Child${i} : Base { int x; };`);
    }
    const scope = new ProjectScope(); scope.setRoots([uri('')]);
    const index = new TypeHierarchyIndex(scope, () => [{ uri: uri('base.h'), version: 1, text }]);
    const collect = semantics.collectTypeHierarchy; let count = 0;
    const spy = mock.method(semantics, 'collectTypeHierarchy', (...args: Parameters<typeof collect>) => { count++; return collect(...args); });
    try {
      index.resume();
      const base = (await index.prepare(uri('base.h'), { line: 0, character: 6 }, token))![0];
      assert.strictEqual((await index.subtypes(base.data, token))?.length, 3);
      count = 0;
      assert.strictEqual((await index.subtypes(base.data, token))?.length, 3);
      assert.strictEqual(count, 0, 'unchanged sources were reparsed');
      fs.writeFileSync(path.join(directory, 'child0.axl'), '#include "base.h"\nclass Replaced : Base { int x; };');
      index.invalidate([uri('child0.axl')]);
      const children = await index.subtypes(base.data, token);
      assert.ok(children?.some(item => item.name === 'Replaced'));
      assert.strictEqual(count, 1, 'an independent edit reparsed unrelated sources');
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
      assert.deepStrictEqual(await index.subtypes(item.data, token), []);
    } finally { await index.dispose(); }
  });

  test('cancels a waiter without cancelling shared indexing', async () => {
    const directory = createTempDir();
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const text = 'class A { int x; }; class B : A { int y; };';
    const scope = new ProjectScope(); scope.setRoots([pathToFileURL(directory).toString()]);
    const index = new TypeHierarchyIndex(scope, () => [{ uri, version: 1, text }]);
    const source = new CancellationTokenSource();
    let began!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const collect = scope.collect.bind(scope);
    const traversal = mock.method(scope, 'collect', async (...args: Parameters<typeof collect>) => {
      began();
      await gate;
      return collect(...args);
    });
    try {
      index.resume();
      const item = (await index.prepare(uri, { line: 0, character: 6 }, token))![0];
      const request = index.subtypes(item.data, source.token);
      await started;
      source.cancel();
      await assert.rejects(request, (error: { code?: number }) => error.code === LSPErrorCodes.RequestCancelled);
      const subsequent = index.subtypes(item.data, token);
      release();
      assert.deepStrictEqual((await subsequent)?.map(item => item.name), ['B']);
      assert.strictEqual(traversal.mock.callCount(), 1, 'cancelling a waiter must not restart the shared build');
    } finally { release(); source.dispose(); await index.dispose(); traversal.mock.restore(); }
  });
});
