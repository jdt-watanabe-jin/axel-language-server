import * as assert from 'assert';
import type { Hover } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP editing latency', function () {
  this.timeout(60_000);

  test('large document edits and queued edits return current hover within budget', async () => {
    const server = startLspServer();
    const uri = 'file:///axel-performance/editing.axl';
    const textDocument = { uri };
    const position = { line: 1, character: 14 };
    const text = ['int value1;', 'void main() { value1 = 1; }',
      ...Array.from({ length: 2000 }, (_, i) => `int item${i};`)].join('\n');
    const samples: Record<string, number[]> = { singleEdit: [], burstEdit: [] };
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
        capabilities: { textDocument: { hover: { contentFormat: ['markdown'] } } }, initializationOptions: {}
      });
      await server.notify('initialized', {});
      const openStart = performance.now();
      await server.notify('textDocument/didOpen', { textDocument: { uri, version, languageId: 'axel', text } });
      await hover();
      const openMs = performance.now() - openStart;
      for (const [scenario, editCount] of [['singleEdit', 1], ['burstEdit', 5]] as const) {
        for (let i = 0; i < 20; i++) {
          // Start before sending edits so server-side queuing and analysis are included.
          const start = performance.now();
          for (let j = 0; j < editCount; j++) { await edit(); }
          await hover();
          samples[scenario].push(performance.now() - start);
        }
      }
      console.log(`    initialOpenMs=${openMs.toFixed(1)} lines=2002`);
      assert.ok(openMs < 2000, `initial open took ${openMs.toFixed(1)}ms (budget 2000ms)`);
      for (const [scenario, values] of Object.entries(samples)) {
        const sorted = [...values].sort((a, b) => a - b);
        const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1];
        const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
        const max = sorted[sorted.length - 1];
        const budget = 500;
        console.log(`    ${scenario} n=${values.length} p50Ms=${p50.toFixed(1)} p95Ms=${p95.toFixed(1)} maxMs=${max.toFixed(1)}`);
        assert.ok(p95 < budget, `${scenario} p95 ${p95.toFixed(1)}ms exceeds ${budget}ms`);
      }
    } finally {
      await server.stop();
    }
  });
});
