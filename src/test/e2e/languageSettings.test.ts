import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Hover, CompletionItem } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP language settings', function () {
  this.timeout(30_000);
  test('disables hover and completion at initialization and toggles them independently live', async () => {
    const server = startLspServer();
    const uri = pathToFileURL(path.join(os.tmpdir(), 'language-settings.axl')).toString();
    const params = { textDocument: { uri }, position: { line: 0, character: 5 } };
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: {},
        initializationOptions: { hover: 'disabled', autocomplete: 'disabled' } });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: {
        uri, languageId: 'axel', version: 1, text: 'int myValue;\nvoid main() { myValue; }'
      } });
      assert.strictEqual(await server.request('textDocument/hover', params), null);
      assert.deepStrictEqual(await server.request('textDocument/completion', params), []);
      await server.notify('workspace/didChangeConfiguration', { settings: { hover: 'default', autocomplete: 'disabled' } });
      assert.ok(await server.request<Hover>('textDocument/hover', params));
      assert.deepStrictEqual(await server.request('textDocument/completion', params), []);
      await server.notify('workspace/didChangeConfiguration', { settings: { hover: 'disabled', autocomplete: 'default' } });
      assert.strictEqual(await server.request('textDocument/hover', params), null);
      const completions = await server.request<CompletionItem[]>('textDocument/completion', {
        textDocument: { uri }, position: { line: 1, character: 16 }
      });
      assert.ok(completions.some(item => item.label === 'myValue'), JSON.stringify(completions));
      await server.notify('workspace/didChangeConfiguration', { settings: { hover: 'invalid', autocomplete: null } });
      assert.ok(await server.request<Hover>('textDocument/hover', params));
    } finally { await server.stop(); }
  });

});
