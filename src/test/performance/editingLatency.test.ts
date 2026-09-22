import * as assert from 'assert';
import type { Hover } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP editing latency', function () {
  this.timeout(60_000);

  test('single and queued edits return the latest hover', async () => {
    const server = startLspServer();
    const uri = 'file:///axel-performance/editing.axl';
    const textDocument = { uri };
    const position = { line: 1, character: 14 };
    const text = ['int value1;', 'void main() { value1 = 1; }',
      ...Array.from({ length: 20 }, (_, i) => `int item${i};`)].join('\n');
    let version = 1;
    let currentType = 'int';
    let currentName = 'value1';
    async function hover() {
      const result = await server.request<Hover>('textDocument/hover', { textDocument, position });
      assert.deepStrictEqual(result.contents, { kind: 'markdown', value: `\x60\x60\x60axel\n${currentType} ${currentName}\n\x60\x60\x60` });
    }
    async function edit() {
      const nextType = currentType === 'int' ? 'string' : 'int';
      const nextName = 'value' + (version + 1);
      await server.notify('textDocument/didChange', {
        textDocument: { uri, version: ++version },
        contentChanges: [{ range: { start: { line: 0, character: 0 },
          end: { line: 0, character: currentType.length + 1 + currentName.length } }, text: `${nextType} ${nextName}` },
          { range: { start: { line: 1, character: 14 }, end: { line: 1, character: 14 + currentName.length } }, text: nextName }]
      });
      currentType = nextType;
      currentName = nextName;
    }
    try {
      await server.request('initialize', {
        processId: null, rootUri: null,
        capabilities: { textDocument: { hover: { contentFormat: ['markdown'] } } }, configuration: {}
      });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, version, languageId: 'axel', text } });
      await hover();
      for (const editCount of [1, 5]) {
        for (let j = 0; j < editCount; j++) { await edit(); }
        await hover();
      }
    } finally {
      await server.stop();
    }
  });
});
