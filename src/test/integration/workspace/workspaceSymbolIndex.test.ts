import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { mock } from 'node:test';
import * as extraction from '../../../analyzer/workspaceSymbols/extract';
import * as query from '../../../analyzer/workspaceSymbols/query';
import { WorkspaceSymbolIndex } from '../../../analyzer/workspaceSymbols/index';
import { normalizeWorkspaceSymbolSettings } from '../../../analyzer/workspaceSymbols/config';
import { useWorkspaceFixtures } from '../../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
suite('Workspace Symbol index', () => {
  const indexes: WorkspaceSymbolIndex[] = [];
  teardown(async () => { for (const index of indexes) { await index.dispose(); } indexes.length = 0; });
  function setup() {
    const root = createTempDir(); const file = path.join(root, 'main.axl');
    const index = new WorkspaceSymbolIndex(error => assert.fail(error)); indexes.push(index);
    index.setRoots([pathToFileURL(root).toString()]); index.start();
    return { root, file, uri: pathToFileURL(file).toString(), index };
  }
  const names = async (index: WorkspaceSymbolIndex) => (await index.search('', CancellationToken.None)).map(x => x.name);
  test('does not return cached symbols when configuration pauses a pending search', async () => {
    const { file, index } = setup(); fs.writeFileSync(file, 'int oldValue;');
    assert.deepStrictEqual(await names(index), ['oldValue']);
    const pending = names(index);
    index.pause();
    await assert.rejects(pending, (error: unknown) => (error as { code: number }).code === LSPErrorCodes.ContentModified);
  });
  test('uses unopened files, prioritizes unsaved text and restores disk after close', async () => {
    const { file, uri, index } = setup(); fs.writeFileSync(file, 'int disk;');
    assert.deepStrictEqual(await names(index), ['disk']);
    index.updateDocument({ uri, version: 1, text: 'int unsaved;' });
    fs.writeFileSync(file, 'int changedOnDisk;');
    assert.deepStrictEqual(await names(index), ['unsaved']);
    index.closeDocument(uri);
    assert.deepStrictEqual(await names(index), ['changedOnDisk']);
  });
  test('recovers missed create/delete and directory move notifications', async () => {
    const { root, file, index } = setup(); fs.writeFileSync(file, 'int first;');
    assert.deepStrictEqual(await names(index), ['first']);
    fs.mkdirSync(path.join(root, 'nested')); fs.renameSync(file, path.join(root, 'nested', 'moved.AXL'));
    const result = await index.search('first', CancellationToken.None);
    assert.strictEqual(result.length, 1); assert.ok(result[0].uri.endsWith('/nested/moved.AXL'));
    fs.unlinkSync(path.join(root, 'nested', 'moved.AXL'));
    assert.deepStrictEqual(await names(index), []);
  });
  test('rebuilds configuration and roots without reviving excluded entries', async () => {
    const { root, file, index } = setup(); fs.writeFileSync(file, '#if FLAG\nint enabled;\n#else\nint disabled;\n#endif');
    index.configure(normalizeWorkspaceSymbolSettings({ defines: ['FLAG=1'] }));
    assert.deepStrictEqual(await names(index), ['enabled']);
    index.configure(normalizeWorkspaceSymbolSettings({ workspaceSymbols: { exclude: ['**/main.axl'] } }));
    assert.deepStrictEqual(await names(index), []);
    index.configure(normalizeWorkspaceSymbolSettings({}));
    assert.deepStrictEqual(await names(index), ['disabled']);
    index.setRoots([pathToFileURL(path.join(root, 'absent')).toString()]);
    // A missing root is logged by the production enumerator; use root removal instead.
    index.setRoots([]);
    assert.deepStrictEqual(await names(index), []);
  });
  test('keeps deleted open buffers until close and restricts external buffers to folderless workspaces', async () => {
    const { file, uri, index } = setup(); fs.writeFileSync(file, 'int disk;');
    index.updateDocument({ uri, version: 1, text: 'int buffer;' }); fs.unlinkSync(file);
    assert.deepStrictEqual(await names(index), ['buffer']);
    index.closeDocument(uri); assert.deepStrictEqual(await names(index), []);
    const outside = pathToFileURL(path.join(createTempDir(), 'outside.axl')).toString();
    index.updateDocument({ uri: outside, version: 1, text: 'int outside;' });
    assert.deepStrictEqual(await names(index), []);
    index.setRoots([]); assert.deepStrictEqual(await names(index), ['outside']);
  });
  test('cancels a waiting search without cancelling background work', async () => {
    const { root, index } = setup();
    for (let i = 0; i < 80; i++) { fs.writeFileSync(path.join(root, `file${i}.axl`), `int symbol${i};`); }
    const source = new CancellationTokenSource();
    try {
      const pending = index.search('', source.token); source.cancel();
      await assert.rejects(pending, (e: unknown) => (e as { code: number }).code === LSPErrorCodes.RequestCancelled);
      assert.strictEqual((await names(index)).length, 80);
    } finally { source.dispose(); }
  });
  test('reuses unchanged files and reparses only the notified file', async () => {
    const { root, file, uri, index } = setup();
    fs.writeFileSync(file, 'int first;'); fs.writeFileSync(path.join(root, 'other.axl'), 'int other;');
    const original = extraction.extractWorkspaceSymbols; const parsed: string[] = [];
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      parsed.push(args[0].text); return original(...args);
    });
    try {
      assert.deepStrictEqual(await names(index), ['first', 'other']);
      parsed.length = 0; assert.deepStrictEqual(await names(index), ['first', 'other']);
      assert.deepStrictEqual(parsed, []);
      fs.writeFileSync(file, 'int changed;'); index.invalidateFiles([uri]);
      assert.deepStrictEqual(await names(index), ['changed', 'other']);
      assert.deepStrictEqual(parsed, ['int changed;']);
      index.updateDocument({ uri, version: 1, text: 'int buffer;' });
      assert.deepStrictEqual(await names(index), ['buffer', 'other']);
      parsed.length = 0;
      index.invalidateFiles([uri]);
      assert.deepStrictEqual(await names(index), ['buffer', 'other']);
      assert.deepStrictEqual(parsed, [], 'a disk watcher must not reparse an unchanged buffer');
    } finally { await index.dispose(); spy.mock.restore(); }
  });
  test('discards an in-flight disk extraction after an unsaved edit', async () => {
    const { file, uri, index } = setup(); fs.writeFileSync(file, 'int disk;');
    const original = extraction.extractWorkspaceSymbols;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      if (args[0].text === 'int disk;') { entered(); await gate; } return original(...args);
    });
    try {
      const pending = names(index); await started;
      index.updateDocument({ uri, version: 1, text: 'int fresh;' }); release();
      assert.deepStrictEqual(await pending, ['fresh']);
    } finally { release(); await index.dispose(); spy.mock.restore(); }
  });
  test('does not bypass excluded ancestor directories with an open buffer', async () => {
    const { root, index } = setup();
    index.configure(normalizeWorkspaceSymbolSettings({ workspaceSymbols: { exclude: ['src'] } }));
    index.updateDocument({ uri: pathToFileURL(path.join(root, 'src', 'new.axl')).toString(), version: 1, text: 'int excluded;' });
    assert.deepStrictEqual(await names(index), []);
  });
  test('preserves completed work across edits during initial indexing', async () => {
    const { root, index } = setup();
    const uris = [0, 1, 2].map(i => pathToFileURL(path.join(root, `${i}.axl`)).toString());
    uris.forEach((uri, i) => index.updateDocument({ uri, version: 1, text: `int symbol${i};` }));
    const original = extraction.extractWorkspaceSymbols; const parsed: string[] = [];
    let edited = false;
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      parsed.push(args[0].text);
      if (!edited && args[0].text === 'int symbol1;') {
        edited = true; index.updateDocument({ uri: uris[2], version: 2, text: 'int fresh;' });
      }
      return original(...args);
    });
    try {
      assert.deepStrictEqual(await names(index), ['fresh', 'symbol0', 'symbol1']);
      assert.strictEqual(parsed.filter(text => text === 'int symbol0;').length, 1);
      assert.strictEqual(parsed.filter(text => text === 'int symbol1;').length, 1);
    } finally { await index.dispose(); spy.mock.restore(); }
  });
  test('does not publish extraction completed under an obsolete configuration', async () => {
    const { file, index } = setup(); fs.writeFileSync(file, '#if FLAG\nint enabled;\n#else\nint disabled;\n#endif');
    const original = extraction.extractWorkspaceSymbols; let configured = false;
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      if (!configured) { configured = true; index.configure(normalizeWorkspaceSymbolSettings({ defines: ['FLAG=1'] })); }
      return original(...args);
    });
    try { assert.deepStrictEqual(await names(index), ['enabled']); }
    finally { await index.dispose(); spy.mock.restore(); }
  });
  test('rejects obsolete results if an edit arrives during matching', async () => {
    const { file, uri, index } = setup(); fs.writeFileSync(file, 'int old;');
    assert.deepStrictEqual(await names(index), ['old']);
    const original = query.searchWorkspaceSymbols;
    const spy = mock.method(query, 'searchWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      index.updateDocument({ uri, version: 1, text: 'int fresh;' }); return original(...args);
    });
    try { await assert.rejects(names(index), (e: unknown) => (e as { code: number }).code === LSPErrorCodes.ContentModified); }
    finally { await index.dispose(); spy.mock.restore(); }
  });
  test('reconciles a missed creation when a search joins an older scan', async () => {
    const { root, file, index } = setup(); fs.writeFileSync(file, 'int first;');
    const original = extraction.extractWorkspaceSymbols;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      if (args[0].text === 'int first;') { entered(); await gate; } return original(...args);
    });
    try {
      await started;
      fs.writeFileSync(path.join(root, 'new.axl'), 'int second;');
      const pending = names(index); release();
      assert.deepStrictEqual(await pending, ['first', 'second']);
    } finally { release(); await index.dispose(); spy.mock.restore(); }
  });
});
