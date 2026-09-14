import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Macro presentation LSP', function () {
  this.timeout(30_000);
  const { createTempDir } = useWorkspaceFixtures();
  test('returns object alias expansion and only macro tokens at the written name', async () => {
    const root = createTempDir();
    fs.writeFileSync(path.join(root, '_cdscompack.h'), '#define CDSPRINT printf');
    const uri = pathToFileURL(path.join(root, 'consumer.axl')).toString();
    const server = startLspServer();
    try {
      const initialized = await server.request<{ capabilities: { semanticTokensProvider: { legend: { tokenTypes: string[] } } } }>(
        'initialize', { processId: null, rootUri: null, capabilities: {} });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'axel',
        text: '#include "_cdscompack.h"\nvoid printf(string value) {}\nvoid main() { CDSPRINT("hello"); }' } });
      const hover = await server.request<{ contents: { value: string } }>('textDocument/hover', {
        textDocument: { uri }, position: { line: 2, character: 14 } });
      assert.ok(hover.contents.value.includes('#define CDSPRINT printf'), JSON.stringify(hover));
      assert.ok(hover.contents.value.includes('printf("hello")'), JSON.stringify(hover));
      assert.ok(hover.contents.value.includes('_cdscompack'), JSON.stringify(hover));
      const result = await server.request<{ data: number[] }>('textDocument/semanticTokens/full', { textDocument: { uri } });
      let line = 0, character = 0;
      const matches: string[] = [];
      for (let i = 0; i < result.data.length; i += 5) {
        line += result.data[i];
        character = result.data[i] === 0 ? character + result.data[i + 1] : result.data[i + 1];
        if (line === 2 && character <= 14 && character + result.data[i + 2] > 14) {
          matches.push(initialized.capabilities.semanticTokensProvider.legend.tokenTypes[result.data[i + 3]]);
          assert.strictEqual(result.data[i + 2], 'CDSPRINT'.length);
        }
      }
      assert.deepStrictEqual(matches, ['macro']);
    } finally { await server.stop(); }
  });
});
