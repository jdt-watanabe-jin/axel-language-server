import * as assert from 'assert';
import { registerHandlers } from '../../lsp/registerHandlers';
import { createHandlerConnection, emptyAnalysis, type TestDocument } from '../support/handlerFixtures';

suite('document change scheduling', () => {
  function fixture() {
    const documents = new Map<string, TestDocument>();
    const indexed: { uri: string; version: number }[] = [];
    let open!: (event: { document: TestDocument }) => void;
    let change!: (event: { document: TestDocument }) => void;
    let close!: (event: { document: TestDocument }) => void;
    let hover!: (params: { textDocument: { uri: string }; position: { line: number; character: number } }) => unknown;
    let onIndexed: (() => void) | undefined;
    registerHandlers({
      connection: createHandlerConnection({ onHover: (handler: typeof hover) => { hover = handler; } }) as never,
      documents: {
        get: (uri: string) => documents.get(uri),
        onDidOpen: (handler: typeof open) => { open = handler; },
        onDidChangeContent: (handler: typeof change) => { change = handler; },
        onDidClose: (handler: typeof close) => { close = handler; }
      } as never,
      analyzer: { analyzeDocument: input => {
        indexed.push({ uri: input.uri, version: input.version });
        onIndexed?.();
        return emptyAnalysis({ uri: input.uri, version: input.version });
      } },
      logger: { error: message => { throw new Error(message); } }
    });
    function document(uri: string, version: number) {
      const doc = { uri, version, getText: () => `int value${version};` };
      documents.set(uri, doc);
      return doc;
    }
    return {
      indexed,
      open(uri: string, version = 1) { open({ document: document(uri, version) }); },
      change(uri: string, version: number) { change({ document: document(uri, version) }); },
      close(uri: string) {
        const doc = documents.get(uri)!;
        documents.delete(uri);
        close({ document: doc });
      },
      hover(uri: string) { return hover({ textDocument: { uri }, position: { line: 0, character: 0 } }); },
      nextIndex() { return new Promise<void>(resolve => { onIndexed = resolve; }); }
    };
  }

  test('coalesces changes and flushes the latest revision before a request', () => {
    const f = fixture();
    f.open('file:///main.axl');
    for (let version = 2; version <= 6; version++) { f.change('file:///main.axl', version); }
    assert.deepStrictEqual(f.indexed, [{ uri: 'file:///main.axl', version: 1 }]);
    f.hover('file:///main.axl');
    assert.ok(f.indexed.some(input => input.version === 6));
    assert.ok(f.indexed.every(input => input.version === 1 || input.version === 6));
    f.close('file:///main.axl');
  });

  test('flushes changed dependencies before a request in another document', () => {
    const f = fixture();
    f.open('file:///header.h');
    f.open('file:///main.axl');
    f.change('file:///header.h', 2);
    f.change('file:///header.h', 3);
    f.hover('file:///main.axl');
    assert.deepStrictEqual(f.indexed.slice(2), [
      { uri: 'file:///header.h', version: 3 }, { uri: 'file:///main.axl', version: 1 }
    ]);
    f.close('file:///header.h');
    f.close('file:///main.axl');
  });

  test('preserves an intermediate revision requested before a later edit', () => {
    const f = fixture();
    f.open('file:///main.axl');
    f.change('file:///main.axl', 2);
    f.hover('file:///main.axl');
    assert.strictEqual(f.indexed[f.indexed.length - 1].version, 2);
    f.change('file:///main.axl', 3);
    f.hover('file:///main.axl');
    assert.strictEqual(f.indexed[f.indexed.length - 1].version, 3);
    f.close('file:///main.axl');
  });

  test('indexes the latest revision without waiting for a request', async () => {
    const f = fixture();
    f.open('file:///main.axl');
    const indexed = f.nextIndex();
    f.change('file:///main.axl', 2);
    f.change('file:///main.axl', 3);
    await indexed;
    assert.deepStrictEqual(f.indexed, [
      { uri: 'file:///main.axl', version: 1 }, { uri: 'file:///main.axl', version: 3 }
    ]);
    f.close('file:///main.axl');
  });

  test('closing one URI drops its edits without dropping another pending URI', async () => {
    const f = fixture();
    f.open('file:///closed.axl');
    f.open('file:///kept.axl');
    const indexed = f.nextIndex();
    f.change('file:///closed.axl', 2);
    f.change('file:///kept.axl', 2);
    f.close('file:///closed.axl');
    await indexed;
    assert.deepStrictEqual(f.indexed.slice(2), [{ uri: 'file:///kept.axl', version: 2 }]);
    f.close('file:///kept.axl');
  });
  test('discards pending changes when closing and reopening a URI', () => {
    const f = fixture();
    f.open('file:///main.axl');
    f.change('file:///main.axl', 2);
    f.close('file:///main.axl');
    f.open('file:///main.axl');
    f.hover('file:///main.axl');
    assert.ok(f.indexed.every(input => input.version === 1));
    f.close('file:///main.axl');
  });
});
