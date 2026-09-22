import * as assert from 'assert';
import { mock } from 'node:test';
import { getCompletions, completionDocumentation } from '../../../analyzer/completion';
import { toLspCompletionItemForClient } from '../../../lsp/completion';
import { marked } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

const { createWorkspaceIndex } = useWorkspaceFixtures();
suite('R3 completion documentation cost', () => {
  test('defers documentation lookup until selection and preserves eager details', () => {
    const { text, position } = marked(Array.from({ length: 3 }, (_, i) =>
      `/** Describes function ${i}. */\nvoid function${i}(int count);`).join('\n') + '\nvoid main() { fun| }');
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({ uri: 'file:///r3-cost/main.axl', text, version: 1 });
    const original = index.documentationBindings.bind(index);
    const spy = mock.method(index, 'documentationBindings', original);
    try {
      const input = { analysis, text, position, workspaceIndex: index };
      const eager = getCompletions(input);
      spy.mock.resetCalls();
      const lazy = getCompletions({ ...input, deferDocumentation: true });
      assert.strictEqual(spy.mock.callCount(), 0, 'listing must not bind or render declaration documentation');
      const selected = lazy.find(item => item.name === 'function1')!;
      assert.ok(selected.documentationTarget);
      const resolved = { ...selected, ...completionDocumentation(input, selected.documentationTarget) };
      assert.ok(resolved.documentation?.includes('Describes function 1.'));
      assert.ok(!resolved.documentation?.includes('Describes function 0.'));
      assert.ok(!resolved.documentation?.includes('Describes function 2.'));
      assert.deepStrictEqual(toLspCompletionItemForClient(resolved, true),
        toLspCompletionItemForClient(eager.find(item => item.name === 'function1')!, true));
      const withoutDocs = (items: typeof eager) => items.map(item => {
        const { documentation: _documentation, ...rest } = toLspCompletionItemForClient(item, true);
        void _documentation; return rest;
      });
      assert.deepStrictEqual(withoutDocs(lazy), withoutDocs(eager));
    } finally { spy.mock.restore(); }
  });
});
