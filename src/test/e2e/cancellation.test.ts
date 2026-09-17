import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
suite('LSP stdio cancellation', function () {
  this.timeout(15000);
  test('cancels dependency analysis over stdio and serves the next request', async () => {
    const root = createTempDir();
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(root, 'header' + i + '.h'),
        (i < 99 ? '#include "header' + (i + 1) + '.h"\n' : '') + 'int value' + i + ';');
    }
    const uri = pathToFileURL(path.join(root, 'main.axl')).toString();
    const server = startLspServer();
    const source = new CancellationTokenSource();
    let timer: NodeJS.Timeout | undefined;
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: {} });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: {
        uri, version: 1, languageId: 'axel', text: '#include "header0.h"\nint main(){return value99;}'
      } });
      const pending = server.request('textDocument/diagnostic', { textDocument: { uri } }, source.token);
      timer = setTimeout(() => source.cancel(), 20);
      await assert.rejects(pending, (e: unknown) => (e as { code?: number }).code === LSPErrorCodes.RequestCancelled);
      await server.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'int fresh;' }] });
      const result = await server.request<{ name: string }[]>('textDocument/documentSymbol', { textDocument: { uri } });
      assert.deepStrictEqual(result.map(symbol => symbol.name), ['fresh']);
    } finally { clearTimeout(timer); source.dispose(); await server.stop(); }
  });
});
