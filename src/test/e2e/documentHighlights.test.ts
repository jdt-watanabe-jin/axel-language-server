import * as assert from 'assert';
import { CancellationTokenSource, DocumentHighlightKind, LSPErrorCodes,
  type DocumentHighlight, type InitializeResult } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP stdio Document highlights', function () {
  this.timeout(15_000);
  let server: ReturnType<typeof startLspServer>;
  const uri = 'file:///axel-highlights/main.axl';
  setup(() => { server = startLspServer(); });
  teardown(async () => { await server.stop(); });
  async function initialize() {
    const result = await server.request<InitializeResult>('initialize', {
      processId: null, rootUri: null, capabilities: {}, configuration: {}
    });
    await server.notify('initialized', {});
    return result;
  }
  async function open(text: string) {
    await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text } });
  }
  const highlight = (line: number, character: number, targetUri = uri) => server.request<DocumentHighlight[]>(
    'textDocument/documentHighlight', { textDocument: { uri: targetUri }, position: { line, character } });

  test('advertises the provider and returns exact source ranges and access kinds', async () => {
    assert.strictEqual((await initialize()).capabilities.documentHighlightProvider, true);
    await open('int value = 0;\nvoid main() { value += 1; int copy = value; }');
    assert.deepStrictEqual(await highlight(0, 5), [
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, kind: DocumentHighlightKind.Write },
      { range: { start: { line: 1, character: 14 }, end: { line: 1, character: 19 } }, kind: DocumentHighlightKind.Write },
      { range: { start: { line: 1, character: 37 }, end: { line: 1, character: 42 } }, kind: DocumentHighlightKind.Read }
    ]);
    assert.deepStrictEqual(await highlight(0, 0), []);
    assert.deepStrictEqual(await highlight(0, 5, 'file:///not-open.axl'), []);
  });

  test('reflects unsaved edits and returns Text for an uninitialized declaration', async () => {
    await initialize();
    await open('int value = 0;\nvoid main() { value++; }');
    await highlight(0, 5);
    await server.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 }, contentChanges: [{ text: 'int value;' }]
    });
    assert.deepStrictEqual(await highlight(0, 5), [{
      range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, kind: DocumentHighlightKind.Text
    }]);
  });

  test('preserves cancellation rather than returning an empty success', async () => {
    await initialize();
    await open('int value;\n' + Array.from({ length: 600 }, (_, i) => `void f${i}() { value++; }`).join('\n'));
    const source = new CancellationTokenSource();
    try {
      const pending = server.request('textDocument/documentHighlight', {
        textDocument: { uri }, position: { line: 0, character: 5 }
      }, source.token);
      source.cancel();
      await assert.rejects(pending, (error: unknown) => (error as { code?: number }).code === LSPErrorCodes.RequestCancelled);
    } finally { source.dispose(); }
  });
});
