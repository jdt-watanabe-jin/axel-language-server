import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { LSPErrorCodes, type WorkspaceSymbol, type InitializeResult } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
const stale = (error: unknown) => (error as { code: number }).code === LSPErrorCodes.ContentModified;
suite('R3 Workspace Symbol Resolve', function () {
  this.timeout(20000);
  test('negotiates lazy ranges, resolves current buffers and rejects stale identities and scope', async () => {
    const root = fs.realpathSync.native(createTempDir()); const file = path.join(root, 'main.axl');
    fs.writeFileSync(file, 'int target;');
    const uri = pathToFileURL(file).toString(); const rootUri = pathToFileURL(root).toString();
    const server = startLspServer();
    try {
      const initialized = await server.request<InitializeResult>('initialize', { processId: null, rootUri,
        capabilities: { workspace: { workspaceFolders: true, symbol: { resolveSupport: { properties: ['location.range'] } } } } });
      assert.deepStrictEqual(initialized.capabilities.workspaceSymbolProvider, { resolveProvider: true });
      await server.notify('initialized', {});
      const search = () => server.request<WorkspaceSymbol[]>('workspace/symbol', { query: 'target' });
      const [symbol] = await search();
      assert.deepStrictEqual(symbol.location, { uri }); assert.ok(symbol.data);
      const resolve = (item = symbol) => server.request<WorkspaceSymbol>('workspaceSymbol/resolve', item);
      assert.deepStrictEqual((await resolve()).location, { uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } } });
      assert.strictEqual((await search())[0].data, symbol.data);
      assert.ok('range' in (await resolve({ ...symbol, location: { uri: uri.replace('/main.axl', '/%6dain.axl') } })).location);
      await assert.rejects(resolve({ ...symbol, location: { uri: rootUri } }), stale);
      await assert.rejects(resolve({ ...symbol, name: 'forged' }), stale);
      await assert.rejects(resolve({ ...symbol, data: {} }), stale);
      const bufferUri = uri.replace('/main.axl', '/%6dain.axl');
      await server.notify('textDocument/didOpen', { textDocument: { uri: bufferUri, languageId: 'axel', version: 1, text: '\nint target;' } });
      assert.strictEqual((await search())[0].data, symbol.data, 'opening an equivalent URI preserves identity');
      assert.deepStrictEqual((await resolve()).location, { uri: bufferUri, range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } } });
      await server.notify('textDocument/didChange', { textDocument: { uri: bufferUri, version: 2 }, contentChanges: [{ text: 'int renamed;' }] });
      await assert.rejects(resolve(), stale);
      await server.notify('textDocument/didChange', { textDocument: { uri: bufferUri, version: 3 }, contentChanges: [{ text: 'int target;\nint target;' }] });
      await assert.rejects(resolve(), stale);
      await server.notify('textDocument/didClose', { textDocument: { uri: bufferUri } });
      await server.configure({ settings: { project: { exclude: ['**/main.axl'] } } });
      await assert.rejects(resolve(), stale);
      await server.configure({ settings: {} });
      assert.ok('range' in (await resolve()).location);
      fs.renameSync(file, path.join(root, 'moved.axl'));
      await assert.rejects(resolve(), stale);
      const [moved] = await search(); assert.ok(moved.location.uri.endsWith('/moved.axl'));
      fs.unlinkSync(path.join(root, 'moved.axl'));
      await assert.rejects(resolve(moved), stale);
      fs.writeFileSync(file, 'int target;');
      await server.notify('workspace/didChangeWorkspaceFolders', { event: { added: [], removed: [{ uri: rootUri, name: 'root' }] } });
      await assert.rejects(resolve(), stale);
    } finally { await server.stop(); }
  });
  test('keeps eager ranges for clients without location.range resolution', async () => {
    const root = createTempDir(); fs.writeFileSync(path.join(root, 'main.axl'), 'int target;');
    const server = startLspServer();
    try {
      const initialized = await server.request<InitializeResult>('initialize', { processId: null, rootUri: pathToFileURL(root).toString(),
        capabilities: { workspace: { symbol: { resolveSupport: { properties: ['other'] } } } } });
      assert.strictEqual(initialized.capabilities.workspaceSymbolProvider, true);
      await server.notify('initialized', {});
      const [symbol] = await server.request<WorkspaceSymbol[]>('workspace/symbol', { query: '' });
      assert.ok('range' in symbol.location); assert.strictEqual(symbol.data, undefined);
    } finally { await server.stop(); }
  });
});
