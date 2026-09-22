import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
import { type InitializeResult } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('R5 editing over stdio', function () {
  this.timeout(15000);
  test('advertises local input formatting, applies only indentation and does not opt into save edits', async () => {
    const server = startLspServer();
    const uri = 'file:///r5-input.axl';
    try {
      const result = await server.request<InitializeResult>('initialize', { processId: null, rootUri: null, capabilities: {} });
      assert.deepStrictEqual(result.capabilities.documentOnTypeFormattingProvider, { firstTriggerCharacter: '}', moreTriggerCharacter: ['\n'] });
      assert.ok(!JSON.stringify(result.capabilities.textDocumentSync).includes('willSave'));
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'axel', text: 'void main() {\n    }' } });
      const edits = await server.request('textDocument/onTypeFormatting', {
        textDocument: { uri }, position: { line: 1, character: 5 }, ch: '}', options: { insertSpaces: true, tabSize: 2 }
      });
      assert.deepStrictEqual(edits, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: '' }]);
      await server.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'void main() {\n' }] });
      assert.deepStrictEqual(await server.request('textDocument/onTypeFormatting', {
        textDocument: { uri }, position: { line: 1, character: 0 }, ch: '\n', options: { insertSpaces: true, tabSize: 2 }
      }), [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: '  ' }]);
    } finally { await server.stop(); }
  });
  test('advertises Code Action Resolve only when edit and data are supported', async () => {
    for (const supported of [false, true]) {
      const server = startLspServer();
      try {
        const result = await server.request<InitializeResult>('initialize', {
          processId: null, rootUri: null, capabilities: supported ? { textDocument: { codeAction: { dataSupport: true, resolveSupport: { properties: ['edit'] } } } } : {}
        });
        const capability = result.capabilities.codeActionProvider;
        assert.ok(capability && typeof capability === 'object');
        assert.strictEqual(capability.resolveProvider === true, supported);
      } finally { await server.stop(); }
    }
  });
  test('resolves manual include edits and rejects candidates after source or settings changes', async () => {
    const server = startLspServer();
    const root = createTempDir();
    const uri = pathToFileURL(path.join(root, 'main.axl')).toString();
    const headerUri = pathToFileURL(path.join(root, 'types.h')).toString();
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: {
        textDocument: { codeAction: { dataSupport: true, resolveSupport: { properties: ['edit'] } } }
      } });
      await server.notify('initialized', {});
      for (const [file, text] of [['types.h', 'class R5Widget {};'], ['main.axl', 'R5Widget widget;']]) {
        await server.notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(path.join(root, file)).toString(), languageId: 'axel', version: 1, text } });
      }
      await server.request('textDocument/diagnostic', { textDocument: { uri: headerUri } });
      const list = () => server.request<import('vscode-languageserver/node').CodeAction[]>('textDocument/codeAction', {
        textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, context: { diagnostics: [] }
      });
      assert.deepStrictEqual(await server.request('textDocument/codeAction', {
        textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        context: { diagnostics: [], only: ['source.fixAll'] }
      }), [], 'save/source actions must not offer manual include fixes');
      const actions = await list();
      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].edit, undefined);
      assert.ok(actions[0].data);
      const resolved = await server.request<import('vscode-languageserver/node').CodeAction>('codeAction/resolve', actions[0]);
      assert.match(JSON.stringify(resolved.edit), /#include/);
      assert.strictEqual(resolved.title, actions[0].title);
      await server.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'R5Widget other;' }] });
      await assert.rejects(server.request('codeAction/resolve', actions[0]), (error: { code: number }) => error.code === -32801);
      const fresh = (await list())[0];
      assert.ok(fresh);
      await server.configure({ settings: { autocomplete: 'disabled' } });
      await assert.rejects(server.request('codeAction/resolve', fresh), (error: { code: number }) => error.code === -32801);
    } finally { await server.stop(); }
  });
});
