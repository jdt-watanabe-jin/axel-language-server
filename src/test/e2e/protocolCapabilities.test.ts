import * as assert from 'assert';
import type { InitializeResult, RegistrationParams } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP capability negotiation', function () {
  this.timeout(15000);
  for (const supported of [false, true]) {
    test(`only uses optional refresh and registration when supported=${supported}`, async () => {
      const server = startLspServer();
      const requests: string[] = [];
      const registrations: RegistrationParams[] = [];
      for (const method of ['workspace/semanticTokens/refresh', 'workspace/diagnostic/refresh', 'workspace/inlayHint/refresh']) {
        server.onRequest(method, () => { requests.push(method); return null; });
      }
      server.onRequest('client/registerCapability', params => { registrations.push(params as RegistrationParams); return null; });
      const uri = 'file:///capabilities.axl';
      try {
        const initialized = await server.rawRequest<InitializeResult>('initialize', {
          processId: null, rootUri: null,
          capabilities: { workspace: { configuration: true,
            didChangeConfiguration: { dynamicRegistration: supported },
            semanticTokens: { refreshSupport: supported }, diagnostics: { refreshSupport: supported },
            inlayHint: { refreshSupport: supported },
            fileOperations: { willRename: supported, didRename: supported } } }
        });
        assert.strictEqual(initialized.capabilities.definitionProvider, true);
        assert.strictEqual(initialized.capabilities.typeDefinitionProvider, true);
        assert.strictEqual(initialized.capabilities.selectionRangeProvider, true);
        assert.strictEqual(Boolean(initialized.capabilities.workspace?.fileOperations?.willRename), supported);
        assert.strictEqual(Boolean(initialized.capabilities.workspace?.fileOperations?.didRename), supported);
        assert.strictEqual(initialized.capabilities.workspace?.fileOperations?.willDelete, undefined);
        await server.notify('initialized', {});
        await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text: 'int value;\nvoid main(){ value = 1; }' } });
        const definition = await server.request('textDocument/definition', { textDocument: { uri }, position: { line: 1, character: 14 } });
        assert.deepStrictEqual(definition, [{ uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } }]);
        await server.notify('textDocument/didClose', { textDocument: { uri } });
        // A request ordered after close is a transport/handler barrier, not a timing sleep.
        assert.strictEqual(await server.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 5 } }), null);
        await server.configure({ settings: { inlayHints: { parameterNames: { enabled: true } } } });
        await server.request('textDocument/inlayHint', {
          textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }
        });
        await server.stop();
        if (supported) {
          assert.ok(requests.includes('workspace/semanticTokens/refresh'));
          assert.ok(requests.includes('workspace/diagnostic/refresh'));
          assert.ok(requests.includes('workspace/inlayHint/refresh'));
          assert.deepStrictEqual(registrations.flatMap(params => params.registrations.map(item => item.method)), ['workspace/didChangeConfiguration']);
        } else {
          assert.deepStrictEqual(requests, []);
          assert.deepStrictEqual(registrations, []);
        }
      } finally { await server.stop(); }
    });
  }

  test('registration failure does not prevent configuration and language features', async () => {
    const server = startLspServer();
    server.onRequest('client/registerCapability', () => { throw new Error('registration deliberately rejected'); });
    const uri = 'file:///registration-failure.axl';
    try {
      await server.rawRequest('initialize', { processId: null, rootUri: null,
        capabilities: { workspace: { configuration: true, didChangeConfiguration: { dynamicRegistration: true } } } });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'axel', text: 'int value;' } });
      const hover = await server.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 5 } });
      assert.match(JSON.stringify(hover), /int value/);
    } finally { await server.stop(); }
  });
});
