import * as assert from 'assert';
import { CancellationToken, LSPErrorCodes, ResponseError, type DocumentHighlightParams } from 'vscode-languageserver/node';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import { registerHandlers } from '../../support/configuredHandlers';
import { createHandlerConnection, createTestDocument, type TestDocument } from '../../support/handlerFixtures';

suite('Document highlight request lifecycle', () => {
  function fixture() {
    const analyzer = new WorkspaceIndex();
    const errors: string[] = [];
    let document = createTestDocument('int value;');
    let highlight!: (params: DocumentHighlightParams, token?: CancellationToken) => Promise<unknown>;
    let change!: (event: { document: TestDocument }) => void;
    registerHandlers({
      connection: createHandlerConnection({
        sendNotification() {},
        onDocumentHighlight(handler: typeof highlight) { highlight = handler; }
      }) as never,
      analyzer,
      documents: {
        get: () => document, onDidOpen() {}, onDidClose() {},
        onDidChangeContent(handler: typeof change) { change = handler; }
      } as never,
      logger: { error: message => errors.push(message) }
    });
    return { analyzer, errors,
      request: () => highlight({ textDocument: { uri: document.uri }, position: { line: 0, character: 5 } }),
      update: () => { document = { ...createTestDocument('int changed;'), version: 2 }; change({ document }); }
    };
  }

  test('logs analysis failure and returns no stale highlights', async () => {
    const f = fixture();
    assert.strictEqual((await f.request() as unknown[]).length, 1);
    f.analyzer.analyzeRequestDocument = async () => { throw new Error('analysis failed'); };
    assert.deepStrictEqual(await f.request(), []);
    assert.deepStrictEqual(f.errors, ['Document highlight failed: analysis failed']);
  });

  test('propagates content modification while analysis is pending', async () => {
    const f = fixture();
    const analyze = f.analyzer.analyzeRequestDocument.bind(f.analyzer);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.analyzer.analyzeRequestDocument = async (input, token) => {
      entered(); await blocked; return analyze(input, token);
    };
    const pending = f.request();
    const rejected = assert.rejects(pending, error => error instanceof ResponseError && error.code === LSPErrorCodes.ContentModified);
    await started;
    f.update();
    release();
    await rejected;
    assert.deepStrictEqual(f.errors, []);
    await f.analyzer.waitForBackgroundIndexing();
  });
});
