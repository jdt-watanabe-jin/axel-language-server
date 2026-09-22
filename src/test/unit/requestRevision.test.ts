import * as assert from 'assert';
import { CancellationToken, LSPErrorCodes } from 'vscode-languageserver/node';
import { registerHandlers } from '../support/configuredHandlers';
import { createHandlerConnection, createTestDocument, emptyAnalysis, type TestDocument } from '../support/handlerFixtures';
suite('asynchronous request revisions', () => {
  test('rejects a queued request whose positions belong to the previous document revision', async () => {
    let hover!: (params: { textDocument: { uri: string }; position: { line: number; character: number } }, token: CancellationToken) => Promise<unknown>;
    let change!: (event: { document: TestDocument }) => void;
    let close!: (event: { document: TestDocument }) => void;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const notifications: unknown[] = [];
    let document = createTestDocument('int old;');
    registerHandlers({ connection: createHandlerConnection({
      onHover: (handler: typeof hover) => { hover = handler; },
      sendNotification: (_method: string, params: unknown) => { notifications.push(params); }
    }) as never, documents: {
      get: () => document, onDidOpen() {}, onDidChangeContent(handler: typeof change) { change = handler; },
      onDidClose(handler: typeof close) { close = handler; }
    } as never, analyzer: {
      analyzeDocument: () => emptyAnalysis(),
      async analyzeRequestDocument() { entered(); await wait; return emptyAnalysis(); }
    }, logger: { error: message => assert.fail(message) } });
    const pending = hover({ textDocument: { uri: document.uri }, position: { line: 0, character: 5 } }, CancellationToken.None);
    await started;
    const queued = hover({ textDocument: { uri: document.uri }, position: { line: 0, character: 5 } }, CancellationToken.None);
    void queued.catch(() => undefined);
    document = { ...createTestDocument('string latest;'), version: 2 };
    change({ document });
    release();
    await assert.rejects(pending, (e: unknown) => (e as { code?: number }).code === LSPErrorCodes.ContentModified);
    await assert.rejects(queued, (e: unknown) => (e as { code?: number }).code === LSPErrorCodes.ContentModified);
    close({ document });
    assert.deepStrictEqual(notifications, []);
  });
});
