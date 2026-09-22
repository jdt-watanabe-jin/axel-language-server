import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes, type DocumentOnTypeFormattingParams, type TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { registerOnTypeFormattingHandler } from '../../lsp/onTypeFormatting';

suite('R5 input formatting scheduling', () => {
  function fixture(text: string) {
    let document: TextDocument | undefined = TextDocument.create('file:///input.axl', 'axel', 1, text);
    let handler!: (params: DocumentOnTypeFormattingParams, token?: CancellationToken) => Promise<TextEdit[]>;
    registerOnTypeFormattingHandler({
      connection: { onDocumentOnTypeFormatting: (value: typeof handler) => { handler = value; } } as never,
      documents: { get: () => document } as never,
      analyzer: { analyzeDocument: () => { throw new Error('Input formatting must not analyze dependencies'); } },
      configuration: { ready: () => { throw new Error('Input formatting must not wait for configuration'); } } as never,
      logger: { error: message => { throw new Error(message); } }
    });
    return {
      run: (token = CancellationToken.None) => handler({
        textDocument: { uri: 'file:///input.axl' }, position: { line: text.split('\n').length - 1, character: 0 },
        ch: '\n', options: { insertSpaces: true, tabSize: 2 }
      }, token),
      change: () => { document = TextDocument.create('file:///input.axl', 'axel', 2, text + 'changed'); },
      close: () => { document = undefined; }
    };
  }
  test('does not wait for configuration or invoke dependency analysis', async () => {
    const result = await fixture('void main() {\n').run();
    assert.strictEqual(result[0].newText, '  ');
  });
  test('rejects a queued edit after document change', async () => {
    const subject = fixture('void main() {\n' + '\n'.repeat(500));
    const pending = subject.run();
    subject.change();
    await assert.rejects(pending, (error: { code: number }) => error.code === LSPErrorCodes.ContentModified);
  });
  test('honors cancellation and missing documents', async () => {
    const subject = fixture('void main() {\n');
    const source = new CancellationTokenSource();
    source.cancel();
    try { await assert.rejects(subject.run(source.token), (error: { code: number }) => error.code === LSPErrorCodes.RequestCancelled); }
    finally { source.dispose(); }
    subject.close();
    assert.deepStrictEqual(await subject.run(), []);
  });
});
