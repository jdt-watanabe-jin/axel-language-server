import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { type InitializeResult, type ApplyWorkspaceEditParams, type ShowDocumentParams, type WorkspaceSymbol } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';

const { createTempDir } = useWorkspaceFixtures();
suite('R4 operations over stdio', function () {
  this.timeout(15000);
  test('advertises commands, rebuilds unopened symbols and preserves buffers', async () => {
    const root = fs.realpathSync.native(createTempDir());
    const uri = pathToFileURL(path.join(root, 'main.axl')).toString();
    fs.writeFileSync(path.join(root, 'main.axl'), 'int onDisk;');
    fs.writeFileSync(path.join(root, 'unopened.axl'), 'int unopened;');
    const server = startLspServer();
    try {
      const initialized = await server.request<InitializeResult>('initialize', { processId: null, rootUri: pathToFileURL(root).toString(), capabilities: {} });
      assert.deepStrictEqual(initialized.capabilities.executeCommandProvider?.commands, ['axel.rebuildIndex', 'axel.applyQuickFix', 'axel.showSource']);
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 7, text: 'int unsaved;' } });
      assert.deepStrictEqual(await server.request('workspace/executeCommand', { command: 'axel.rebuildIndex' }), { rebuilt: true, documents: 1 });
      const symbols = await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: '' });
      assert.deepStrictEqual(symbols.map(symbol => symbol.name).sort(), ['unopened', 'unsaved']);
      assert.strictEqual(fs.readFileSync(path.join(root, 'main.axl'), 'utf8'), 'int onDisk;');
    } finally { await server.stop(); }
  });

  for (const response of [null, []]) {
    test(`honors an empty workspace/folders response (${JSON.stringify(response)})`, async () => {
      const root = fs.realpathSync.native(createTempDir());
      fs.writeFileSync(path.join(root, 'main.axl'), 'int removedRoot;');
      const server = startLspServer();
      let requests = 0;
      server.onRequest('workspace/workspaceFolders', () => { requests++; return response; });
      try {
        await server.request('initialize', { processId: null, rootUri: pathToFileURL(root).toString(), capabilities: { workspace: { workspaceFolders: true } } });
        await server.notify('initialized', {});
        assert.strictEqual((await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: '' })).length, 1);
        await server.request('workspace/executeCommand', { command: 'axel.rebuildIndex' });
        assert.strictEqual(requests, 1);
        assert.deepStrictEqual(await server.request('workspace/symbol', { query: '' }), []);
      } finally { await server.stop(); }
    });
  }

  test('retains folder notifications received while a folder snapshot is pending', async () => {
    const oldRoot = fs.realpathSync.native(createTempDir());
    const newRoot = fs.realpathSync.native(createTempDir());
    fs.writeFileSync(path.join(oldRoot, 'old.axl'), 'int oldRootSymbol;');
    fs.writeFileSync(path.join(newRoot, 'new.axl'), 'int newRootSymbol;');
    const oldFolder = { uri: pathToFileURL(oldRoot).toString(), name: 'old' };
    const newFolder = { uri: pathToFileURL(newRoot).toString(), name: 'new' };
    const server = startLspServer();
    let release!: (folders: typeof oldFolder[]) => void;
    let requested!: () => void;
    const started = new Promise<void>(resolve => { requested = resolve; });
    server.onRequest('workspace/workspaceFolders', () => { requested(); return new Promise(resolve => { release = resolve; }); });
    try {
      await server.request('initialize', { processId: null, rootUri: oldFolder.uri, capabilities: { workspace: { workspaceFolders: true } } });
      await server.notify('initialized', {});
      const rebuilding = server.request('workspace/executeCommand', { command: 'axel.rebuildIndex' });
      await started;
      await server.notify('workspace/didChangeWorkspaceFolders', { event: { added: [newFolder], removed: [oldFolder] } });
      // A request round-trip observes the notification before returning the old snapshot.
      const changed = await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: '' });
      assert.deepStrictEqual(changed.map(symbol => symbol.name), ['newRootSymbol']);
      release([oldFolder]);
      await rebuilding;
      assert.deepStrictEqual((await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: '' })).map(symbol => symbol.name), ['newRootSymbol']);
    } finally { release?.([oldFolder]); await server.stop(); }
  });

  test('sends a versioned edit and survives the client document change before its reply', async () => {
    const root = fs.realpathSync.native(createTempDir());
    const main = pathToFileURL(path.join(root, 'main.axl')).toString();
    const header = pathToFileURL(path.join(root, 'types.h')).toString();
    const server = startLspServer();
    let edit: ApplyWorkspaceEditParams | undefined;
    let opened: ShowDocumentParams | undefined;
    server.onRequest('workspace/applyEdit', async params => {
      edit = params as ApplyWorkspaceEditParams;
      await server.notify('textDocument/didChange', { textDocument: { uri: main, version: 8 }, contentChanges: [{ text: '#include "types.h"\nWidget widget;' }] });
      await server.request('textDocument/documentSymbol', { textDocument: { uri: main } });
      return { applied: true };
    });
    server.onRequest('window/showDocument', params => { opened = params as ShowDocumentParams; return { success: true }; });
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: { workspace: { applyEdit: true, workspaceEdit: { documentChanges: true } }, window: { showDocument: { support: true } } } });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri: header, languageId: 'axel', version: 1, text: 'class Widget {};' } });
      await server.notify('textDocument/didOpen', { textDocument: { uri: main, languageId: 'axel', version: 7, text: 'Widget widget;' } });
      await server.request('workspace/executeCommand', { command: 'axel.rebuildIndex' });
      assert.deepStrictEqual(await server.request('workspace/executeCommand', { command: 'axel.applyQuickFix', arguments: [{ uri: main, position: { line: 0, character: 0 } }] }), { applied: true });
      assert.deepStrictEqual(edit?.edit.documentChanges, [{ textDocument: { uri: main, version: 7 }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '#include "types.h"\n' }] }]);
      const result = await server.request<{ success: boolean }>('workspace/executeCommand', { command: 'axel.showSource', arguments: [{ uri: main, position: { line: 1, character: 0 } }] });
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(opened, { uri: main, external: false, takeFocus: true, selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } } });
    } finally { await server.stop(); }
  });
});
