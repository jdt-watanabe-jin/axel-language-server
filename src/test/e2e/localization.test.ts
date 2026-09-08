import * as assert from 'assert';
import type { CompletionItem, DocumentDiagnosticReport, Hover } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP localization', function () {
  this.timeout(20_000);
  for (const locale of ['ja', 'ja-JP', 'en', 'fr', undefined]) {
    test('uses initialize locale ' + String(locale) + ' for diagnostics and undeclared functions', async () => {
      const server = startLspServer();
      try {
        await server.request('initialize', { processId: null, rootUri: null, capabilities: {}, locale });
        await server.notify('initialized', {});
        const uri = 'file:///axel-i18n/main.axl';
        const textDocument = { uri };
        const text = 'void main() { abs(-1); missing = 1; }';
        await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text } });
        const report = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
        assert.strictEqual(report.kind, 'full');
        if (report.kind !== 'full') { throw new Error('Expected full report'); }
        const japanese = locale?.startsWith('ja');
        assert.ok(report.items.some(item => item.message === (japanese
          ? "不明な識別子 'missing'。" : "Unknown identifier 'missing'.")), JSON.stringify(report));
        const hover = await server.request<Hover | null>('textDocument/hover', {
          textDocument, position: { line: 0, character: text.indexOf('abs') + 1 }
        });
        assert.strictEqual(hover, null);
        const items = await server.request<CompletionItem[]>('textDocument/completion', {
          textDocument, position: { line: 0, character: text.indexOf('abs') + 2 }
        });
        assert.ok(!items.some(item => item.label === 'abs'));
        assert.ok(report.items.some(item => item.range.start.character === text.indexOf('abs')));
        await server.notify('workspace/didChangeConfiguration', { settings: {} });
        const after = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
        assert.deepStrictEqual(after, report, 'configuration changes must preserve locale');
      } finally { await server.stop(); }
    });
  }
});
