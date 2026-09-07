import * as assert from 'assert';
import type { CompletionItem, DocumentDiagnosticReport, Hover } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP localization', function () {
  this.timeout(20_000);
  for (const locale of ['ja', 'ja-JP', 'en', 'fr', undefined]) {
    test('uses initialize locale ' + String(locale) + ' for diagnostics and builtin documentation', async () => {
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
        const hover = await server.request<Hover>('textDocument/hover', {
          textDocument, position: { line: 0, character: text.indexOf('abs') + 1 }
        });
        assert.deepStrictEqual(hover.contents, { kind: 'markdown', value:
          '```axel\nint abs(int)\n```\n\n' + (japanese
            ? '整数の絶対値を計算します。' : 'Calculates the absolute value of an integer.') });
        const items = await server.request<CompletionItem[]>('textDocument/completion', {
          textDocument, position: { line: 0, character: text.indexOf('abs') + 2 }
        });
        assert.strictEqual(items.find(item => item.label === 'abs')?.documentation, japanese
          ? '整数の絶対値を計算します。 出典: docs/axel_users.pdf。'
          : 'Calculates the absolute value of an integer. Source: docs/axel_users.pdf.');
        await server.notify('workspace/didChangeConfiguration', { settings: {} });
        const after = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
        assert.deepStrictEqual(after, report, 'configuration changes must preserve locale');
      } finally { await server.stop(); }
    });
  }
});
