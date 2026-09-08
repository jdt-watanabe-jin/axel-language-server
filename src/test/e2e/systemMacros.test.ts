import * as assert from 'assert';
import type { DocumentDiagnosticReport, Hover, InitializeResult, Range, SemanticTokens } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP system macros', function () {
  this.timeout(20_000);
  const uri = 'file:///axel-system-macros/main.axl';
  const textDocument = { uri };
  const text = [
    '#ifdef __APP_LEDIT__',
    'int ledit;',
    '#elif defined(__APP_SEDIT__)',
    'int sedit;',
    '#else',
    'int consoleMode;',
    '#endif',
    'int l = __APP_LEDIT__;',
    'int s = __APP_SEDIT__;'
  ].join('\n');

  test('uses the supplied tool on each server start and defaults omitted settings to axel', async () => {
    for (const tool of ['ismo', 'asca', undefined]) {
      const server = startLspServer();
      try {
        await server.request('initialize', {
          processId: null, rootUri: null, capabilities: {},
          initializationOptions: tool === undefined ? {} : { tool }
        });
        await server.notify('initialized', {});
        await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text } });
        const report = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
        assert.ok(report.kind === 'full');
        for (const [name, activeTool] of [['__APP_LEDIT__', 'ismo'], ['__APP_SEDIT__', 'asca']]) {
          assert.strictEqual(report.items.some(item => item.message.includes(name)), tool !== activeTool, JSON.stringify(report));
        }
      } finally { await server.stop(); }
    }
  });

  test('updates notifications and language results on tool changes without editing the document', async () => {
    const server = startLspServer();
    try {
      const initialized = await server.request<InitializeResult>('initialize', {
        processId: null, rootUri: null, capabilities: {}, initializationOptions: { tool: 'ismo' }
      });
      const provider = initialized.capabilities.semanticTokensProvider;
      assert.ok(provider && 'legend' in provider);
      const macroType = provider.legend.tokenTypes.indexOf('macro');
      assert.ok(macroType >= 0);
      await server.notify('initialized', {});

      for (const [tool, activeLine, enabledLine, unknownName] of [
        ['ismo', 1, 7, '__APP_SEDIT__'],
        ['asca', 3, 8, '__APP_LEDIT__'],
        ['axel', 5, -1, '__APP_LEDIT__']
      ] as const) {
        let timer: NodeJS.Timeout | undefined;
        const inactive = new Promise<Range[]>((resolve, reject) => {
          const subscription = server.onNotification<{ uri: string; ranges: Range[] }>('axel/inactiveRanges', params => {
            if (params.uri !== uri) { return; }
            const hidden = (line: number) => params.ranges.some(range => range.start.line <= line && range.end.line >= line);
            if ([1, 3, 5].every(line => hidden(line) === (line !== activeLine))) {
              subscription.dispose();
              clearTimeout(timer);
              resolve(params.ranges);
            }
          });
          timer = setTimeout(() => {
            subscription.dispose();
            reject(new Error('Inactive ranges did not reflect tool ' + tool));
          }, 5_000);
        });
        try {
          if (tool === 'ismo') {
            await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text } });
          } else {
            await server.notify('workspace/didChangeConfiguration', { settings: { tool } });
          }
          await inactive;
        } finally { clearTimeout(timer); }

        const report = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
        assert.ok(report.kind === 'full');
        assert.ok(report.items.some(item => item.message.includes(unknownName)), JSON.stringify(report));
        if (tool !== 'axel') {
          const enabledName = tool === 'ismo' ? '__APP_LEDIT__' : '__APP_SEDIT__';
          assert.ok(!report.items.some(item => item.message.includes(enabledName)), JSON.stringify(report));
        } else {
          assert.ok(report.items.some(item => item.message.includes('__APP_SEDIT__')));
        }
        for (const line of [7, 8]) {
          const hover = await server.request<Hover>('textDocument/hover', { textDocument, position: { line, character: 10 } });
          assert.ok(hover);
          const content = JSON.stringify(hover.contents);
          assert.strictEqual(/not defined/i.test(content), line !== enabledLine, content);
        }
        const tokens = await server.request<SemanticTokens>('textDocument/semanticTokens/full', { textDocument });
        let line = 0;
        const macroLines: number[] = [];
        for (let offset = 0; offset < tokens.data.length; offset += 5) {
          line += tokens.data[offset];
          if (tokens.data[offset + 3] === macroType && line >= 7) { macroLines.push(line); }
        }
        assert.deepStrictEqual(macroLines, enabledLine < 0 ? [] : [enabledLine]);
      }
    } finally { await server.stop(); }
  });
});
