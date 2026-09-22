import * as assert from 'assert';
import { type CodeLens, type InitializeResult } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('R3 Code Lens lifecycle over stdio', function () {
  this.timeout(15_000);
  test('toggles without edits, refreshes and blocks old disabled resolves', async () => {
    const server = startLspServer();
    const uri = 'file:///r3-codelens/main.axl';
    let refreshes = 0;
    server.onRequest('workspace/codeLens/refresh', () => { refreshes++; return null; });
    const request = () => server.request<CodeLens[]>('textDocument/codeLens', { textDocument: { uri } });
    const resolve = (lens: CodeLens) => server.request<CodeLens>('codeLens/resolve', lens);
    const waitRefresh = async (previous: number) => {
      const deadline = Date.now() + 2000;
      while (refreshes <= previous && Date.now() < deadline) { await new Promise(done => setTimeout(done, 20)); }
      assert.ok(refreshes > previous);
    };
    try {
      const initialized = await server.request<InitializeResult>('initialize', {
        processId: null, rootUri: null, capabilities: { workspace: { codeLens: { refreshSupport: true } } }
      });
      assert.deepStrictEqual(initialized.capabilities.codeLensProvider, { resolveProvider: true });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', {
        textDocument: { uri, version: 1, languageId: 'axel', text: 'void consume() {}\nvoid main() { consume(); }' }
      });
      assert.deepStrictEqual(await request(), []);
      await server.configure({ settings: { codeLens: { enabled: true } } });
      await waitRefresh(0);
      const items = await request();
      const first = items.find(item => item.range.start.line === 0)!;
      assert.ok(first);
      assert.strictEqual(first.command, undefined);
      const resolved = await resolve(first);
      assert.match(resolved.command!.title, /^1 reference/);
      assert.strictEqual(resolved.command!.command, 'editor.action.showReferences');
      assert.strictEqual(resolved.command!.arguments![2].length, 1);
      const previous = refreshes;
      await server.configure({ settings: { codeLens: { enabled: false } } });
      await waitRefresh(previous);
      assert.deepStrictEqual(await request(), []);
      assert.strictEqual((await resolve(first)).command, undefined);
    } finally { await server.stop(); }
  });
});
