import * as assert from 'assert';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import { registerHandlers } from '../../support/configuredHandlers';
import { createHandlerConnection, createTestDocument, type TestDocument } from '../../support/handlerFixtures';
suite('cooperative document lifecycle', () => {
  test('opening and flushing edits do not fall back to synchronous foreground parsing', async () => {
    const index = new WorkspaceIndex();
    const errors: string[] = [];
    index.analyzeForegroundDocument = () => { throw new Error('synchronous foreground parsing'); };
    let open!: (event: { document: TestDocument }) => void;
    let change!: (event: { document: TestDocument }) => void;
    let hover!: (params: unknown) => Promise<unknown>;
    let document = createTestDocument('int value;');
    registerHandlers({ connection: createHandlerConnection({
      sendNotification() {},
      onHover: (handler: typeof hover) => { hover = handler; }
    }) as never, documents: {
      get: () => document, onDidOpen(handler: typeof open) { open = handler; },
      onDidChangeContent(handler: typeof change) { change = handler; }, onDidClose() {}
    } as never, analyzer: index, logger: { error: message => errors.push(message) } });
    const params = { textDocument: { uri: document.uri }, position: { line: 0, character: 8 } };
    open({ document });
    assert.ok(await hover(params));
    document = { ...createTestDocument('string value;'), version: 2 };
    change({ document });
    assert.ok(JSON.stringify(await hover(params)).includes('string value'));
    assert.deepStrictEqual(errors, []);
    await index.waitForBackgroundIndexing();
  });
  test('opening another document while indexing retains both documents without a request', async () => {
    const index = new WorkspaceIndex();
    const documents = new Map<string, TestDocument>();
    let open!: (event: { document: TestDocument }) => void;
    registerHandlers({ connection: createHandlerConnection({ sendNotification() {} }) as never,
      documents: { get: (uri: string) => documents.get(uri),
        onDidOpen(handler: typeof open) { open = handler; }, onDidChangeContent() {}, onDidClose() {}
      } as never, analyzer: index, logger: { error: message => assert.fail(message) } });
    for (const name of ['first', 'second']) {
      const document = { ...createTestDocument('int ' + name + ';'), uri: 'file:///' + name + '.axl' };
      documents.set(document.uri, document);
      open({ document });
    }
    for (let turn = 0; turn < 250 && (!index.findDeclarations('first').length || !index.findDeclarations('second').length); turn++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.strictEqual(index.findDeclarations('first').length, 1);
    assert.strictEqual(index.findDeclarations('second').length, 1);
    await index.waitForBackgroundIndexing();
  });

});
