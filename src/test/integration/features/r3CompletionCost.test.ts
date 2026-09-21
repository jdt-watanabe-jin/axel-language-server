import * as assert from 'assert';
import { mock } from 'node:test';
import { performance } from 'perf_hooks';
import { getCompletions, completionDocumentation } from '../../../analyzer/completion';
import { toLspCompletionItemForClient } from '../../../lsp/completion';
import { marked } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

const { createWorkspaceIndex } = useWorkspaceFixtures();
suite('R3 completion documentation cost', () => {
  test('defers documentation lookup until selection and preserves eager details', () => {
    const { text, position } = marked(Array.from({ length: 200 }, (_, i) =>
      `/** Describes function ${i}. */\nvoid function${i}(int count);`).join('\n') + '\nvoid main() { fun| }');
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({ uri: 'file:///r3-cost/main.axl', text, version: 1 });
    const original = index.documentationBindings.bind(index);
    const spy = mock.method(index, 'documentationBindings', original);
    try {
      const input = { analysis, text, position, workspaceIndex: index };
      const started = performance.now();
      const eager = getCompletions(input);
      const eagerMs = performance.now() - started;
      assert.ok(spy.mock.callCount() >= 200);
      spy.mock.resetCalls();
      const lazyStarted = performance.now();
      const lazy = getCompletions({ ...input, deferDocumentation: true });
      const lazyMs = performance.now() - lazyStarted;
      assert.strictEqual(spy.mock.callCount(), 0, 'listing must not bind or render declaration documentation');
      const selected = lazy.find(item => item.name === 'function42')!;
      assert.ok(selected.documentationTarget);
      const resolved = { ...selected, ...completionDocumentation(input, selected.documentationTarget) };
      assert.strictEqual(spy.mock.callCount(), 1, 'only the selected declaration requests documentation');
      assert.deepStrictEqual(toLspCompletionItemForClient(resolved, true),
        toLspCompletionItemForClient(eager.find(item => item.name === 'function42')!, true));
      const withoutDocs = (items: typeof eager) => items.map(item => {
        const { documentation: _documentation, ...rest } = toLspCompletionItemForClient(item, true);
        void _documentation; return rest;
      });
      assert.deepStrictEqual(withoutDocs(lazy), withoutDocs(eager));
      process.stdout.write(`    R3 completion: eager=${eagerMs.toFixed(2)}ms, deferred=${lazyMs.toFixed(2)}ms; documentation lookups 0 initially, 1 selected\n`);
    } finally { spy.mock.restore(); }
  });
});
