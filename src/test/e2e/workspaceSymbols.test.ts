import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationTokenSource, LSPErrorCodes, type WorkspaceSymbol, type InitializeResult } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
suite('Workspace Symbol LSP', function () {
  this.timeout(20000);
  test('searches unopened files and tracks buffers, configuration and workspace folders', async () => {
    const root = fs.realpathSync.native(createTempDir()); const file = path.join(root, 'main.axl');
    fs.writeFileSync(file, 'int findMe;');
    const uri = pathToFileURL(file).toString(); const rootUri = pathToFileURL(root).toString();
    const server = startLspServer();
    try {
      const initialized = await server.request<InitializeResult>('initialize', { processId: null, rootUri,
        capabilities: { workspace: { workspaceFolders: true } } });
      assert.ok(initialized.capabilities.workspaceSymbolProvider);
      await server.notify('initialized', {});
      const result = await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: 'find' });
      assert.deepStrictEqual(result.map(x => x.name), ['findMe']);
      assert.deepStrictEqual(result[0].location, { uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } } });
      await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text: 'int unsaved;' } });
      assert.deepStrictEqual((await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: '' })).map(x => x.name), ['unsaved']);
      await server.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'int edited;' }] });
      assert.deepStrictEqual((await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: '' })).map(x => x.name), ['edited']);
      await server.notify('textDocument/didClose', { textDocument: { uri } });
      await server.configure( { settings: { project: { exclude: ['**/main.axl'] } } });
      assert.deepStrictEqual(await server.request('workspace/symbol', { query: '' }), []);
      await server.configure( { settings: { project: { exclude: [] } } });
      assert.strictEqual((await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: 'find' })).length, 1);
      await server.notify('workspace/didChangeWorkspaceFolders', { event: { added: [], removed: [{ uri: rootUri, name: 'root' }] } });
      assert.deepStrictEqual(await server.request('workspace/symbol', { query: '' }), []);
    } finally { await server.stop(); }
  });
  test('cancels initial search, serves document requests and retains background work', async () => {
    const root = createTempDir();
    for (let i = 0; i < 200; i++) { fs.writeFileSync(path.join(root, `${i}.axl`), `int symbol${i};`); }
    const server = startLspServer(10000); const source = new CancellationTokenSource();
    try {
      await server.request('initialize', { processId: null, rootUri: pathToFileURL(root).toString(), capabilities: {} });
      await server.notify('initialized', {});
      const pending = server.request('workspace/symbol', { query: '' }, source.token);
      source.cancel();
      await assert.rejects(pending, (e: unknown) => (e as { code: number }).code === LSPErrorCodes.RequestCancelled);
      const uri = pathToFileURL(path.join(root, '0.axl')).toString();
      await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text: 'int symbol0;' } });
      const outline = await server.request<{ name: string }[]>('textDocument/documentSymbol', { textDocument: { uri } });
      assert.deepStrictEqual(outline.map(x => x.name), ['symbol0']);
      assert.strictEqual((await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: '' })).length, 200);
    } finally { source.dispose(); await server.stop(); }
  });
});
