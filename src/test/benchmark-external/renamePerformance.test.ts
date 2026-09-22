import * as assert from 'assert';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import type { DocumentSymbol, Range, WorkspaceEdit } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('external rename performance', function () {
  this.timeout(180_000);
  test('measures cold outline and renames every occurrence of a sample local', async function () {
    const sample = process.env.AXEL_PERF_SAMPLE;
    const name = process.env.AXEL_PERF_RENAME_SYMBOL;
    if (!sample || !name) { this.skip(); }
    const text = new TextDecoder(process.env.AXEL_PERF_ENCODING ?? 'utf-8').decode(fs.readFileSync(sample));
    const uri = pathToFileURL(sample).toString();
    const offset = text.indexOf(name);
    assert.ok(offset >= 0, 'Configured symbol must exist in the sample');
    const prefix = text.slice(0, offset).split('\n');
    const position = { line: prefix.length - 1, character: prefix.at(-1)!.length };
    const server = startLspServer(120_000);
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: {},
        configuration: JSON.parse(process.env.AXEL_PERF_SETTINGS ?? '{}') });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text } });
      const start = performance.now();
      const symbols = await server.request<DocumentSymbol[]>('textDocument/documentSymbol', { textDocument: { uri } });
      const coldOutlineMs = performance.now() - start;
      assert.ok(symbols.length);
      assert.ok(await server.request<Range>('textDocument/prepareRename', { textDocument: { uri }, position }));
      const renameMs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        const edit = await server.request<WorkspaceEdit>('textDocument/rename', { textDocument: { uri }, position, newName: 'renamedLocal' });
        renameMs.push(performance.now() - started);
        if (i === 0) {
          const edits = Object.values(edit.changes ?? {}).flat();
          assert.ok(edits.length > 1);
          const lines = text.split('\n');
          for (const entry of edits) {
            assert.strictEqual(entry.newText, 'renamedLocal');
            assert.strictEqual(lines[entry.range.start.line].slice(entry.range.start.character, entry.range.end.character), name);
          }
          if (process.env.AXEL_PERF_RENAME_COUNT) {
            assert.strictEqual(edits.length, Number(process.env.AXEL_PERF_RENAME_COUNT));
          }
        }
      }
      console.log(JSON.stringify({ coldOutlineMs, renameMs }));
      assert.ok(Math.max(...renameMs) < 500, 'Renaming a sample local must finish within 500ms after initial indexing');
    } finally { await server.stop(); }
  });
});