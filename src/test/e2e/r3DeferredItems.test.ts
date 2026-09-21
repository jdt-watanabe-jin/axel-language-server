import * as assert from 'assert';
import { ErrorCodes, LSPErrorCodes, type CompletionItem, type InlayHint, type InitializeResult } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('R3 deferred completion and inlay details', function () {
  this.timeout(15_000);
  let server: ReturnType<typeof startLspServer>;
  const uri = 'file:///r3-resolve/main.axl';
  const text = '/** Updates the value.\n * @param count number of items\n */\nvoid consume(int count) {}\nvoid main() { consume(10); }';
  setup(() => { server = startLspServer(); });
  teardown(async () => { await server.stop(); });
  async function initialize(completion = ['documentation', 'detail'], inlay = ['tooltip', 'label.tooltip', 'label.location']) {
    const result = await server.request<InitializeResult>('initialize', {
      processId: null, rootUri: null, capabilities: { textDocument: {
        completion: { completionItem: { resolveSupport: { properties: completion }, documentationFormat: ['markdown'] } },
        inlayHint: { resolveSupport: { properties: inlay } }
      } }, configuration: { inlayHints: { parameterNames: { enabled: true } } }
    });
    await server.notify('initialized', {});
    await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text } });
    return result;
  }
  const complete = () => server.request<CompletionItem[]>('textDocument/completion', {
    textDocument: { uri }, position: { line: 4, character: 18 }
  });
  const hints = () => server.request<InlayHint[]>('textDocument/inlayHint', {
    textDocument: { uri }, range: { start: { line: 4, character: 0 }, end: { line: 4, character: 40 } }
  });

  test('defers supported completion properties while preserving insertion and identity', async () => {
    const initialized = await initialize();
    assert.strictEqual(initialized.capabilities.completionProvider?.resolveProvider, true);
    const item = (await complete()).find(item => item.label === 'consume')!;
    assert.ok(item);
    assert.strictEqual(item.documentation, undefined);
    assert.strictEqual(item.detail, undefined);
    assert.ok(item.data);
    const resolved = await server.request<CompletionItem>('completionItem/resolve', item);
    assert.match(JSON.stringify(resolved.documentation), /Updates the value/);
    assert.match(resolved.detail!, /consume/);
    for (const key of ['label', 'kind', 'insertText', 'textEdit', 'sortText', 'filterText'] as const) {
      assert.deepStrictEqual(resolved[key], item[key]);
    }
  });

  test('keeps eager completion fallback and only defers negotiated properties', async () => {
    await initialize(['documentation'], []);
    const item = (await complete()).find(item => item.label === 'consume')!;
    assert.match(item.detail!, /consume/);
    assert.strictEqual(item.documentation, undefined);
    const resolved = await server.request<CompletionItem>('completionItem/resolve', item);
    assert.strictEqual(resolved.detail, item.detail);
    assert.match(JSON.stringify(resolved.documentation), /Updates the value/);
    const simple = (await hints())[0];
    assert.strictEqual(simple.label, 'count:');
    assert.strictEqual(simple.data, undefined);
  });

  test('returns existing eager documentation to a non-resolve client', async () => {
    await initialize([], []);
    const item = (await complete()).find(item => item.label === 'consume')!;
    assert.match(JSON.stringify(item.documentation), /Updates the value/);
    assert.strictEqual(item.data, undefined);
  });

  test('resolves parameter descriptions and declaration navigation without changing hint placement', async () => {
    const initialized = await initialize();
    assert.deepStrictEqual(initialized.capabilities.inlayHintProvider, { resolveProvider: true });
    const item = (await hints())[0];
    assert.ok(item.data);
    assert.strictEqual(item.tooltip, undefined);
    assert.deepStrictEqual(item.label, [{ value: 'count:' }]);
    const resolved = await server.request<InlayHint>('inlayHint/resolve', item);
    assert.deepStrictEqual(resolved.position, item.position);
    assert.match(JSON.stringify(resolved), /number of items/);
    assert.ok(Array.isArray(resolved.label));
    assert.strictEqual(resolved.label[0].value, 'count:');
    assert.strictEqual(resolved.label[0].location?.uri, uri);
    assert.strictEqual(resolved.label[0].location?.range.start.line, 3);
  });

  test('rejects stale completion and hint details after source or configuration changes', async () => {
    await initialize();
    const item = (await complete()).find(item => item.label === 'consume')!;
    const hint = (await hints())[0];
    await server.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 }, contentChanges: [{ text: text.replace('consume', 'renamed') }]
    });
    await assert.rejects(server.request('completionItem/resolve', item), (error: {code:number}) => error.code === LSPErrorCodes.ContentModified);
    await assert.rejects(server.request('inlayHint/resolve', hint), (error: {code:number}) => error.code === LSPErrorCodes.ContentModified);
    const fresh = (await complete()).find(item => item.label === 'renamed')!;
    await server.configure({ settings: { autocomplete: 'disabled' } });
    await assert.rejects(server.request('completionItem/resolve', fresh), (error: {code:number}) => error.code === LSPErrorCodes.ContentModified);
  });

  test('rejects forged resolve data', async () => {
    await initialize();
    const item = (await complete()).find(item => item.label === 'consume')!;
    await assert.rejects(server.request('completionItem/resolve', { ...item, data: { ...item.data, index: 9000000 } }), (error: {code:number}) => error.code === ErrorCodes.InvalidParams);
  });
});
