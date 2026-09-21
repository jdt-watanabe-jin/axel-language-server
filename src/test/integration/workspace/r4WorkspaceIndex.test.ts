import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { mock } from 'node:test';
import * as extraction from '../../../analyzer/workspaceSymbols/extract';
import { WorkspaceSymbolIndex } from '../../../analyzer/workspaceSymbols/index';
import { useWorkspaceFixtures } from '../../support/workspace';
const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
suite('R4 workspace index ownership', () => {
  function fixture() {
    const root = createTempDir();
    for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(root, `${i}.axl`), `int symbol${i};`); }
    const index = new WorkspaceSymbolIndex(error => assert.fail(error));
    index.setRoots([pathToFileURL(root).toString()]);
    return { index, root };
  }
  test('cancels extraction when its last request waiter leaves', async () => {
    const { index } = fixture(); const source = new CancellationTokenSource();
    const original = extraction.extractWorkspaceSymbols;
    let observed: CancellationToken | undefined;
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      observed = args[1]; source.cancel(); return original(...args);
    });
    try {
      await assert.rejects(index.search('', source.token), (e: unknown) => (e as { code: number }).code === LSPErrorCodes.RequestCancelled);
      assert.ok(observed?.isCancellationRequested, 'the unowned scan token must be cancelled');
    } finally { await index.dispose(); spy.mock.restore(); source.dispose(); }
  });
  test('retains a scan for another waiter after one request cancels', async () => {
    const { index } = fixture(); const source = new CancellationTokenSource();
    const first = index.search('', source.token); const second = index.search('', CancellationToken.None);
    source.cancel();
    try {
      await assert.rejects(first, (e: unknown) => (e as { code: number }).code === LSPErrorCodes.RequestCancelled);
      assert.deepStrictEqual((await second).map(entry => entry.name), ['symbol0', 'symbol1', 'symbol2']);
    } finally { await index.dispose(); source.dispose(); }
  });
  test('rebuild reparses unchanged files while retaining unsaved buffers', async () => {
    const { index, root } = fixture();
    index.updateDocument({ uri: pathToFileURL(path.join(root, '0.axl')).toString(), version: 1, text: 'int unsaved;' });
    await index.search('', CancellationToken.None);
    const original = extraction.extractWorkspaceSymbols; const parsed: string[] = [];
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      parsed.push(args[0].text); return original(...args);
    });
    try {
      const rebuildable = index as WorkspaceSymbolIndex & { rebuild(token: CancellationToken): Promise<void> };
      assert.strictEqual(typeof rebuildable.rebuild, 'function', 'rebuild must be available');
      await rebuildable.rebuild(CancellationToken.None);
      assert.deepStrictEqual(parsed.sort(), ['int symbol1;', 'int symbol2;', 'int unsaved;']);
      assert.deepStrictEqual((await index.search('', CancellationToken.None)).map(entry => entry.name), ['symbol1', 'symbol2', 'unsaved']);
    } finally { await index.dispose(); spy.mock.restore(); }
  });
  test('background progress cancellation stops an otherwise unowned scan and allows restart', async () => {
    const { index } = fixture(); const reports: number[] = [];
    try {
      await index.start(completed => { reports.push(completed); if (completed === 1) { index.cancelBackground(); } });
      assert.deepStrictEqual(reports, [0, 1]);
      assert.deepStrictEqual((await index.search('', CancellationToken.None)).map(entry => entry.name), ['symbol0', 'symbol1', 'symbol2']);
    } finally { await index.dispose(); }
  });

  test('resume completes a background scan cancelled by a configuration pause', async () => {
    const { index } = fixture(); const reports: number[] = [];
    try {
      await index.start(completed => { if (completed === 1) { index.pause(); } });
      await index.resume(completed => reports.push(completed));
      assert.ok(reports.includes(3), 'resume must finish all candidates after an interrupted scan');
    } finally { await index.dispose(); }
  });

  test('finished background ownership does not keep a cancelled rebuild alive', async () => {
    const { index } = fixture(); await index.start();
    const source = new CancellationTokenSource(); const original = extraction.extractWorkspaceSymbols;
    let observed: CancellationToken | undefined;
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      observed = args[1]; source.cancel(); return original(...args);
    });
    try {
      await assert.rejects(index.rebuild(source.token), { code: LSPErrorCodes.RequestCancelled });
      assert.ok(observed?.isCancellationRequested);
    } finally { await index.dispose(); source.dispose(); spy.mock.restore(); }
  });
  test('analysis rebuild invalidates declarations and restores every unsaved open buffer', async () => {
    const root = createTempDir(); const index = createWorkspaceIndex();
    const first = { uri: pathToFileURL(path.join(root, 'first.axl')).toString(), version: 1, text: 'int unsavedFirst;' };
    const second = { uri: pathToFileURL(path.join(root, 'second.axl')).toString(), version: 1, text: 'int unsavedSecond;' };
    await index.analyzeRequestDocument(first, CancellationToken.None);
    await index.analyzeRequestDocument(second, CancellationToken.None);
    const rebuildable = index as typeof index & { rebuildAnalysis(token: CancellationToken): Promise<void> };
    assert.strictEqual(typeof rebuildable.rebuildAnalysis, 'function');
    await rebuildable.rebuildAnalysis(CancellationToken.None);
    assert.deepStrictEqual(index.findDeclarations('unsavedSecond'), []);
    await index.analyzeRequestDocument(first, CancellationToken.None);
    assert.strictEqual(index.findDeclarations('unsavedFirst').length, 1);
    assert.strictEqual(index.findDeclarations('unsavedSecond').length, 1);
  });

  test('cancelling background ownership retains an active symbol waiter', async () => {
    const { index } = fixture(); let waiting: Promise<unknown> | undefined;
    try {
      await index.start(completed => {
        if (completed === 1 && !waiting) {
          waiting = index.search('', CancellationToken.None);
          index.cancelBackground();
        }
      });
      assert.deepStrictEqual((await waiting as { name: string }[]).map(entry => entry.name), ['symbol0', 'symbol1', 'symbol2']);
    } finally { await index.dispose(); }
  });

});
