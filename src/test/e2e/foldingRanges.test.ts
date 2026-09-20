import * as assert from 'assert';
import type { FoldingRange, FoldingRangeClientCapabilities, InitializeResult } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP stdio folding ranges', function () {
  this.timeout(15_000);
  let server: ReturnType<typeof startLspServer>;
  const uri = 'file:///axel-folding/main.axl';
  const textDocument = { uri };
  setup(() => { server = startLspServer(); });
  teardown(async () => { await server.stop(); });

  async function initialize(foldingRange: FoldingRangeClientCapabilities = {}) {
    const result = await server.request<InitializeResult>('initialize', {
      processId: null, rootUri: null, capabilities: { textDocument: { foldingRange } },
      configuration: {}
    });
    await server.notify('initialized', {});
    return result;
  }
  async function open(text: string) {
    await server.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'axel', version: 1, text }
    });
  }
  const fold = () => server.request<FoldingRange[]>('textDocument/foldingRange', { textDocument });

  test('advertises folding and returns original inactive branches and their bodies', async () => {
    const result = await initialize({ lineFoldingOnly: true });
    assert.strictEqual(result.capabilities.foldingRangeProvider, true);
    await open('#if 0\nvoid inactive() {\nint a;\n}\n#else\nvoid active() {\nint b;\n}\n#endif');
    assert.deepStrictEqual(await fold(), [
      { startLine: 0, endLine: 7 }, { startLine: 1, endLine: 2 },
      { startLine: 4, endLine: 7 }, { startLine: 5, endLine: 6 }
    ]);
  });

  test('updates unsaved content and discards closed and reopened versions', async () => {
    await initialize();
    assert.deepStrictEqual(await fold(), []);
    await open('void main() {\nint value;\n}');
    assert.deepStrictEqual(await fold(), [{ startLine: 0, endLine: 1 }]);
    await server.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 }, contentChanges: [{ text: 'void main() {}' }]
    });
    assert.deepStrictEqual(await fold(), []);
    await server.notify('textDocument/didClose', { textDocument });
    assert.deepStrictEqual(await fold(), []);
    await open('/*\n reopened\n */');
    assert.deepStrictEqual(await fold(), [{ startLine: 0, endLine: 2, kind: 'comment' }]);
  });

  for (const lineFoldingOnly of [true, false, undefined]) {
    test(`honors client limit and supported kinds (lineFoldingOnly=${lineFoldingOnly})`, async () => {
      await initialize({ rangeLimit: 2, lineFoldingOnly, foldingRangeKind: { valueSet: ['region'] } });
      await open('#region example\n/*\n comment\n*/\nvoid main() {\nint a;\n}\n#endregion');
      assert.deepStrictEqual(await fold(), [
        { startLine: 0, endLine: 6, kind: 'region' }, { startLine: 1, endLine: 3 }
      ]);
    });
  }

  test('keeps only the outer range for limit one and omits unsupported kinds', async () => {
    await initialize({ rangeLimit: 1, foldingRangeKind: { valueSet: [] } });
    await open('#region example\n/*\n comment\n*/\n#endregion');
    assert.deepStrictEqual(await fold(), [{ startLine: 0, endLine: 3 }]);
  });

  test('ignores code in an unfinished block comment and updates after its terminator is typed', async () => {
    await initialize();
    const source = 'void real() {\nint live;\n}\n/* unclosed\nvoid fake() {\nint hidden;\n}\n#region hidden\n#endregion';
    await open(source);
    assert.deepStrictEqual(await fold(), [{ startLine: 0, endLine: 1 }]);
    const report = await server.request<{ kind: string; items: { message: string }[] }>(
      'textDocument/diagnostic', { textDocument });
    assert.ok(report.items.some(item => item.message === 'Missing */.'));
    await server.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: source + '\n*/\nvoid restored() {\nint value;\n}' }]
    });
    assert.deepStrictEqual(await fold(), [
      { startLine: 0, endLine: 1 }, { startLine: 3, endLine: 9, kind: 'comment' },
      { startLine: 10, endLine: 11 }
    ]);
  });

  test('honors a zero range limit', async () => {
    await initialize({ rangeLimit: 0 });
    await open('void main() {\nint value;\n}');
    assert.deepStrictEqual(await fold(), []);
  });
});
