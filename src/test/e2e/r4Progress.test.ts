import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { LSPErrorCodes } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
suite('R4 progress over stdio', function () {
  this.timeout(30000);
  test('shows shared slow diagnostic/token work once, cancels it and serves subsequent requests', async () => {
    const root = createTempDir();
    for (let i = 0; i < 300; i++) {
      fs.writeFileSync(path.join(root, 'header' + i + '.h'),
        (i < 299 ? '#include "header' + (i + 1) + '.h"\n' : '') + 'int value' + i + ';');
    }
    const uri = pathToFileURL(path.join(root, 'main.axl')).toString();
    const server = startLspServer(20000);
    const events: {kind: string}[] = [];
    let creates = 0;
    server.onRequest('window/workDoneProgress/create', (params: unknown) => {
      const token = (params as {token:string}).token; creates++;
      server.onWorkDoneProgress(token, value => {
        events.push(value);
        if (value.kind === 'begin') { void server.notify('window/workDoneProgress/cancel', { token }); }
      });
      return null;
    });
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: { window: { workDoneProgress: true } } });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'axel',
        text: '#include "header0.h"\nint main(){return value299;}' } });
      const started = Date.now();
      const results = await Promise.allSettled([
        server.request('textDocument/diagnostic', { textDocument: {uri} }),
        server.request('textDocument/semanticTokens/full', { textDocument: {uri} })
      ]);
      assert.strictEqual(creates, 1);
      assert.ok(Date.now() - started >= 900, 'display is delayed');
      for (const result of results) {
        assert.strictEqual(result.status, 'rejected');
        if (result.status === 'rejected') { assert.strictEqual(result.reason.code, LSPErrorCodes.RequestCancelled); }
      }
      await server.notify('textDocument/didChange', { textDocument: {uri, version: 2}, contentChanges: [{text: 'int fresh;'}] });
      const symbols = await server.request<{name:string}[]>('textDocument/documentSymbol', {textDocument:{uri}});
      assert.deepStrictEqual(symbols.map(s => s.name), ['fresh']);
      assert.strictEqual(events.filter(e => e.kind === 'begin').length, 1);
      assert.strictEqual(events.filter(e => e.kind === 'end').length, 1);
    } finally { await server.stop(); }
  });
});
