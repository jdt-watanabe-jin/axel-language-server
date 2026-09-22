import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { mock } from 'node:test';
import { CancellationToken, type Connection, type WorkspaceSymbol } from 'vscode-languageserver/node';
import { registerWorkspaceSymbolHandler } from '../../../lsp/workspaceSymbols';
import * as extraction from '../../../analyzer/workspaceSymbols/extract';
import { useWorkspaceFixtures } from '../../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
suite('R3 Workspace Symbol Resolve cache', () => {
  test('resolves lazy and repeated selections without extracting unchanged files', async () => {
    const root = createTempDir(); const file = path.join(root, 'main.axl');
    fs.writeFileSync(file, Array.from({ length: 3 }, (_, i) => `int symbol${i};`).join('\n'));
    let search!: Parameters<Connection['onWorkspaceSymbol']>[0];
    let resolve!: Parameters<Connection['onWorkspaceSymbolResolve']>[0];
    const original = extraction.extractWorkspaceSymbols;
    let extractions = 0;
    const spy = mock.method(extraction, 'extractWorkspaceSymbols', async (...args: Parameters<typeof original>) => {
      extractions++; return original(...args);
    });
    const lifecycle = registerWorkspaceSymbolHandler({
      connection: { onWorkspaceSymbol: handler => { search = handler; }, onWorkspaceSymbolResolve: handler => { resolve = handler; } } as Connection,
      documents: { onDidChangeContent() {}, onDidClose() {} } as never,
      analyzer: {} as never, logger: { error: message => assert.fail(message) },
      configuration: { async ready() {} } as never
    })!;
    try {
      lifecycle.initialize({ processId: null, rootUri: pathToFileURL(root).toString(), capabilities: {
        workspace: { symbol: { resolveSupport: { properties: ['location.range'] } } }
      } });
      const progress = { begin() {}, report() {}, done() {} };
      const lazy = await search({ query: '' }, CancellationToken.None, progress, undefined) as WorkspaceSymbol[];
      assert.strictEqual(lazy.length, 3); assert.strictEqual(extractions, 1);
      assert.ok(lazy.every(symbol => !('range' in symbol.location)));
      for (const symbol of [lazy[0], lazy[1], lazy[0]]) {
        const result = await resolve(symbol, CancellationToken.None) as WorkspaceSymbol;
        assert.ok('range' in result.location);
      }
      assert.strictEqual(extractions, 1, 'selecting symbols must reuse the index parse');
      fs.writeFileSync(file, 'int duplicate;\nint duplicate;');
      const duplicates = await search({ query: 'duplicate' }, CancellationToken.None, progress, undefined) as WorkspaceSymbol[];
      assert.strictEqual(duplicates.length, 2);
      assert.deepStrictEqual(duplicates.map(symbol => 'range' in symbol.location && symbol.location.range.start.line), [0, 1]);
      assert.ok(duplicates.every(symbol => symbol.data === undefined), 'ambiguous identities retain eager navigation');
    } finally { await lifecycle.dispose(); spy.mock.restore(); }
  });
});
