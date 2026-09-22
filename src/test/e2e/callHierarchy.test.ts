import * as assert from 'assert';
import {
  CancellationTokenSource,
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type InitializeResult,
  LSPErrorCodes,
  SymbolKind
} from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP stdio Call hierarchy', function () {
  this.timeout(15_000);
  let server: ReturnType<typeof startLspServer>;
  const uri = 'file:///axel-call-hierarchy/main.axl';
  const textDocument = { uri };

  setup(() => { server = startLspServer(); });
  teardown(async () => { await server.stop(); });

  async function initialize(): Promise<InitializeResult> {
    const result = await server.request<InitializeResult>('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      configuration: {}
    });
    await server.notify('initialized', {});
    return result;
  }

  async function open(text: string, version = 1): Promise<void> {
    await server.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'axel', version, text }
    });
  }

  const prepare = (line: number, character: number) => server.request<CallHierarchyItem[] | null>(
    'textDocument/prepareCallHierarchy', { textDocument, position: { line, character } }
  );
  const incoming = (item: CallHierarchyItem) => server.request<CallHierarchyIncomingCall[]>(
    'callHierarchy/incomingCalls', { item }
  );
  const outgoing = (item: CallHierarchyItem) => server.request<CallHierarchyOutgoingCall[]>(
    'callHierarchy/outgoingCalls', { item }
  );

  test('advertises the provider and serves prepare, incoming, and outgoing requests', async () => {
    const initialized = await initialize();
    assert.strictEqual(initialized.capabilities.callHierarchyProvider, true);
    await open('void leaf() {}\nvoid caller() { leaf(); leaf(); }');

    const caller = await prepare(1, 6);
    assert.ok(caller);
    assert.strictEqual(caller.length, 1);
    assert.strictEqual(caller[0].name, 'caller');
    assert.strictEqual(caller[0].kind, SymbolKind.Function);
    assert.deepStrictEqual(caller[0].selectionRange, {
      start: { line: 1, character: 5 }, end: { line: 1, character: 11 }
    });

    const calls = await outgoing(caller[0]);
    assert.deepStrictEqual(calls.map(call => ({
      name: call.to.name,
      uri: call.to.uri,
      ranges: call.fromRanges
    })), [{
      name: 'leaf',
      uri,
      ranges: [
        { start: { line: 1, character: 16 }, end: { line: 1, character: 20 } },
        { start: { line: 1, character: 24 }, end: { line: 1, character: 28 } }
      ]
    }]);

    const leaf = await prepare(1, 17);
    assert.ok(leaf);
    assert.strictEqual(leaf[0].name, 'leaf');
    const callers = await incoming(leaf[0]);
    assert.deepStrictEqual(callers.map(call => ({
      name: call.from.name,
      uri: call.from.uri,
      ranges: call.fromRanges
    })), [{
      name: 'caller',
      uri,
      ranges: [
        { start: { line: 1, character: 16 }, end: { line: 1, character: 20 } },
        { start: { line: 1, character: 24 }, end: { line: 1, character: 28 } }
      ]
    }]);
  });

  test('uses current unsaved context and rejects malformed or stale items', async () => {
    await initialize();
    await open('void oldTarget() {}\nvoid caller() { oldTarget(); }');
    const caller = await prepare(1, 6);
    const oldTarget = await prepare(0, 6);
    assert.ok(caller && oldTarget);

    await server.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'void newTarget() {}\nvoid caller() { newTarget(); }' }]
    });
    const updated = await outgoing(caller[0]);
    assert.deepStrictEqual(updated.map(call => call.to.name), ['newTarget']);
    assert.deepStrictEqual(await incoming(oldTarget[0]), []);

    const malformed = { ...caller[0], data: { sourceUri: uri } } as CallHierarchyItem;
    assert.deepStrictEqual(await incoming(malformed), []);
    assert.deepStrictEqual(await outgoing({ ...malformed, data: { key: 'caller' } }), []);
    assert.deepStrictEqual(await server.request('callHierarchy/incomingCalls', { item: {} }), []);
    assert.strictEqual(await prepare(30, 0), null);
  });

  test('preserves cancellation instead of returning an empty success', async () => {
    await initialize();
    const declarations = Array.from({ length: 600 }, (_, index) => `void f${index}() {${index ? ` f${index - 1}();` : ''} }`);
    await open(declarations.join('\n'));
    const item = await prepare(599, 6);
    assert.ok(item);

    const source = new CancellationTokenSource();
    try {
      const pending = outgoingWithToken(item[0], source);
      source.cancel();
      await assert.rejects(pending,
        (error: unknown) => (error as { code?: number }).code === LSPErrorCodes.RequestCancelled);
    } finally { source.dispose(); }
  });

  function outgoingWithToken(item: CallHierarchyItem, source: CancellationTokenSource) {
    return server.request<CallHierarchyOutgoingCall[]>('callHierarchy/outgoingCalls', { item }, source.token);
  }
});
