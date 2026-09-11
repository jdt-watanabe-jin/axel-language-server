import * as assert from 'assert';
import type { DocumentDiagnosticReport } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP localization', function () {
  this.timeout(20_000);
  for (const locale of ['ja-JP', undefined]) {
    test('uses initialize locale ' + String(locale) + ' for diagnostics and retains it after configuration changes', async () => {
      const server = startLspServer();
      try {
        await server.request('initialize', { processId: null, rootUri: null, capabilities: {}, locale });
        await server.notify('initialized', {});
        const uri = 'file:///axel-i18n/main.axl';
        const textDocument = { uri };
        const text = 'void main() { missing = 1; }';
        await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text } });
        const report = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
        assert.strictEqual(report.kind, 'full');
        if (report.kind !== 'full') { throw new Error('Expected full report'); }
        const japanese = locale?.startsWith('ja');
        assert.ok(report.items.some(item => item.message === (japanese
          ? "不明な識別子 'missing'。" : "Unknown identifier 'missing'.")), JSON.stringify(report));
        await server.notify('workspace/didChangeConfiguration', { settings: {} });
        const after = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
        assert.deepStrictEqual(after, report, 'configuration changes must preserve locale');
      } finally { await server.stop(); }
    });
  }
});
