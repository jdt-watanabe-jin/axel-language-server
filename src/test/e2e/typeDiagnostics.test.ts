import * as assert from 'assert';
import type { Diagnostic, DocumentDiagnosticReport } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('Type checking: LSP diagnostics', function () {
  this.timeout(20_000);
  for (const locale of ['en', 'ja-JP']) {
    test(`publishes success, type error and correction with ${locale} messages`, async () => {
      const server = startLspServer();
      try {
        await server.request('initialize', { processId: null, rootUri: null, capabilities: {}, locale });
        await server.notify('initialized', {});
        const uri = 'file:///type-e2e/lifecycle.axl';
        const textDocument = { uri };
        async function diagnostics(): Promise<Diagnostic[]> {
          const report = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
          assert.strictEqual(report.kind, 'full');
          if (report.kind !== 'full') { throw new Error('Expected full diagnostic report'); }
          return report.items;
        }
        await server.notify('textDocument/didOpen', { textDocument: {
          uri, languageId: 'axel', version: 1, text: 'void main(){ int *p=nullptr; }'
        } });
        assert.deepStrictEqual(await diagnostics(), []);
        const broken = 'void main(){ int *p=0; }';
        await server.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: broken }] });
        const items = await diagnostics();
        assert.strictEqual(items.length, 1, JSON.stringify(items));
        assert.strictEqual(items[0].code, 'axel.type.initialization');
        assert.strictEqual(items[0].severity, 1);
        assert.deepStrictEqual(items[0].range, {
          start: { line: 0, character: broken.indexOf('0') }, end: { line: 0, character: broken.indexOf('0') + 1 }
        });
        assert.strictEqual(items[0].message, locale === 'en'
          ? "Cannot initialize 'int*' with 'int'." : "型'int*'を型'int'の値で初期化できません。");
        await server.notify('workspace/didChangeConfiguration', { settings: {} });
        assert.deepStrictEqual(await diagnostics(), items, 'Configuration must retain the connection locale');
        await server.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'void main(){ int *p=nullptr; }' }] });
        assert.deepStrictEqual(await diagnostics(), []);
      } finally { await server.stop(); }
    });
  }
  test('reports C57/C47 equivalents as errors and applies the configured problem limit', async () => {
    const server = startLspServer();
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: {}, locale: 'en' });
      await server.notify('initialized', {});
      const uri = 'file:///type-e2e/runtime-reported.axl';
      const textDocument = { uri };
      await server.notify('textDocument/didOpen', { textDocument: {
        uri, languageId: 'axel', version: 1, text: 'void f(int value);\nint g(){ return; }\nvoid main(){}'
      } });
      const before = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
      assert.ok(before.kind === 'full');
      const prototype = before.items.find(item => item.code === 'axel.type.prototype');
      const missingReturn = before.items.find(item => item.code === 'axel.type.return');
      assert.ok(prototype && missingReturn, JSON.stringify(before));
      assert.strictEqual(prototype.severity, 1);
      assert.strictEqual(missingReturn.severity, 1);
      assert.strictEqual(prototype.range.start.line, 0);
      assert.strictEqual(missingReturn.range.start.line, 1);
      await server.notify('workspace/didChangeConfiguration', { settings: { maxNumberOfProblems: 1 } });
      const limited = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
      assert.ok(limited.kind === 'full');
      assert.strictEqual(limited.items.length, 1);
      assert.deepStrictEqual(limited.items[0], before.items[0]);
    } finally { await server.stop(); }
  });
});
