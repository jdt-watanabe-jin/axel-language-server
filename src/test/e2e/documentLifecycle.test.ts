import * as assert from 'assert';
import type { DocumentDiagnosticReport, Hover, InitializeResult, Location } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP stdio document lifecycle', function () {
  this.timeout(15_000);
  let server: ReturnType<typeof startLspServer>;
  const uri = 'file:///axel-e2e/main.axl';
  const textDocument = { uri };
  setup(async () => {
    server = startLspServer();
    const initialized = await server.request<InitializeResult>('initialize', {
      processId: null, rootUri: null, capabilities: {}, initializationOptions: {}
    });
    assert.strictEqual(initialized.capabilities.hoverProvider, true);
    await server.notify('initialized', {});
  });
  teardown(async () => { await server?.stop(); });

  async function open(text: string) {
    await server.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'axel', version: 1, text }
    });
  }

  test('incremental edits replace hover and definition results without stale symbols', async () => {
    await open('int value;\nvoid main() { value = 1; }');
    const position = { line: 1, character: 14 };
    const before = await server.request<Hover>('textDocument/hover', { textDocument, position });
    assert.deepStrictEqual(before.contents, { kind: 'markdown', value: '```axel\nint value\n```' });
    await server.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'string' }]
    });
    const after = await server.request<Hover>('textDocument/hover', { textDocument, position });
    assert.deepStrictEqual(after.contents, { kind: 'markdown', value: '```axel\nstring value\n```' });
    const definitions = await server.request<Location[]>('textDocument/definition', { textDocument, position });
    assert.deepStrictEqual(definitions, [{ uri, range: {
      start: { line: 0, character: 7 }, end: { line: 0, character: 12 }
    } }]);
  });

  test('closing and reopening the same URI at version one discards prior analysis', async () => {
    await open('int oldName;\nvoid main() { oldName = 1; }');
    const position = { line: 1, character: 14 };
    assert.ok(await server.request<Hover>('textDocument/hover', { textDocument, position }));
    await server.notify('textDocument/didClose', { textDocument });
    assert.strictEqual(await server.request('textDocument/hover', { textDocument, position }), null);
    await open('string newName;\nvoid main() { newName = "ok"; }');
    const hover = await server.request<Hover>('textDocument/hover', { textDocument, position });
    assert.deepStrictEqual(hover.contents, { kind: 'markdown', value: '```axel\nstring newName\n```' });
  });

  test('pull diagnostics clear after malformed source is repaired', async () => {
    await open('void main( {');
    const broken = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
    assert.strictEqual(broken.kind, 'full');
    assert.ok(broken.kind === 'full' && broken.items.some(item => item.severity === 1));
    await server.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 }, contentChanges: [{ text: 'void main() {}' }]
    });
    assert.deepStrictEqual(await server.request('textDocument/diagnostic', { textDocument }), { kind: 'full', items: [] });
  });
});
