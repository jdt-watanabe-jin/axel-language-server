import * as assert from 'assert';
import { startLspServer } from '../support/lspClient';

suite('LSP configuration contract', function () {
  this.timeout(15000);
  test('rejects clients without configuration support', async () => {
    const server = startLspServer();
    try {
      await assert.rejects(server.rawRequest('initialize', { processId: null, rootUri: null, capabilities: {} }), /configuration support/);
    } finally { await server.stop(); }
  });
  test('ignores legacy payloads, reports errors and recovers with unsaved contents', async () => {
    const server = startLspServer();
    const uri = 'file:///configuration-contract.axl';
    const params = { textDocument: { uri }, position: { line: 0, character: 5 } };
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: {},
        initializationOptions: { hover: 'disabled' } });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'axel', text: 'int value;' } });
      assert.ok(await server.request('textDocument/hover', params));
      await server.notify('workspace/didChangeConfiguration', { settings: { hover: 'disabled' } });
      assert.ok(await server.request('textDocument/hover', params));
      await server.configure({ settings: null });
      await assert.rejects(server.request('textDocument/hover', params), /configuration unavailable/);
      await server.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'string value;' }] });
      await server.configure({ settings: {} });
      assert.match(JSON.stringify(await server.request('textDocument/hover', { ...params, position: { line: 0, character: 9 } })), /string/);
    } finally { await server.stop(); }
  });
});
