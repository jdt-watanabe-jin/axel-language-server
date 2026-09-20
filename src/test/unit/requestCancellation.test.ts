import * as assert from 'assert';
import { CancellationTokenSource, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import { registerHandlers } from '../support/configuredHandlers';
import { createHandlerConnection, createTestDocument, emptyAnalysis } from '../support/handlerFixtures';

type Handler = (params: never, token: CancellationTokenSource['token']) => unknown;
const methods = ['onHover', 'onCompletion', 'onDefinition', 'onReferences', 'onPrepareRename',
  'onRenameRequest', 'onCodeAction', 'onSignatureHelp', 'onDocumentSymbol',
  'onDocumentFormatting', 'onDocumentRangeFormatting', 'diagnostic', 'semanticTokens'];
function fixture(fail?: () => void) {
  const handlers = new Map<string, Handler>();
  const errors: string[] = [];
  let analyses = 0;
  const capture = (name: string) => (handler: Handler) => handlers.set(name, handler);
  const connection = createHandlerConnection({
    ...Object.fromEntries(methods.map(name => [name, capture(name)])),
    onInitialize: capture('initialize'), onShutdown: capture('shutdown'),
    languages: { diagnostics: { on: capture('diagnostic') }, semanticTokens: { on: capture('semanticTokens') } }
  });
  registerHandlers({ connection: connection as never,
    documents: { get: () => createTestDocument('int value;'), onDidOpen() {}, onDidChangeContent() {}, onDidClose() {} } as never,
    analyzer: { analyzeDocument() { analyses++; fail?.(); return emptyAnalysis(); } },
    logger: { error: message => errors.push(message) }
  });
  const params = { textDocument: { uri: 'file:///main.axl' }, position: { line: 0, character: 4 },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
    context: { includeDeclaration: true, diagnostics: [] }, newName: 'renamed',
    options: { tabSize: 2, insertSpaces: true }, capabilities: { workspace: { configuration: true } } };
  return { handlers, errors, analyses: () => analyses, params: params as never };
}
const cancelled = (error: unknown) => error instanceof ResponseError && error.code === LSPErrorCodes.RequestCancelled;
suite('LSP request cancellation', () => {
  for (const name of [...methods, 'initialize', 'shutdown']) {
    test(name + ' rejects an already cancelled request without analysis or errors', async () => {
      const f = fixture();
      const source = new CancellationTokenSource(); source.cancel();
      await assert.rejects(async () => name === 'shutdown' ? f.handlers.get(name)!(source.token as never, source.token) : f.handlers.get(name)!(f.params, source.token), cancelled);
      assert.strictEqual(f.analyses(), 0);
      assert.deepStrictEqual(f.errors, []);
      source.dispose();
    });
  }
  for (const name of methods.filter(name => !name.includes('Formatting'))) {
    test(name + ' propagates cancellation from analysis instead of an empty success', async () => {
      const f = fixture(() => { throw new ResponseError(LSPErrorCodes.RequestCancelled, 'cancelled'); });
      const source = new CancellationTokenSource();
      await assert.rejects(async () => name === 'shutdown' ? f.handlers.get(name)!(source.token as never, source.token) : f.handlers.get(name)!(f.params, source.token), cancelled);
      assert.deepStrictEqual(f.errors, []);
      source.dispose();
    });
  }
  test('rejects a request cancelled during analysis before publishing a result', async () => {
    const source = new CancellationTokenSource();
    const f = fixture(() => source.cancel());
    await assert.rejects(async () => f.handlers.get('onHover')!(f.params, source.token), cancelled);
    assert.deepStrictEqual(f.errors, []);
    source.dispose();
  });
});
