import * as assert from 'assert';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { buildTypeContext, lookupBinding } from '../../analyzer/typeChecking/declarations';
import type { Binding } from '../../analyzer/typeChecking/model';

suite('Type binding lookup scaling', () => {
  function context() {
    const analysis = new DocumentAnalyzer().analyzeDocument({ uri: 'file:///bindings.axl', version: 1,
      text: Array.from({length: 500}, (_, i) => 'int value' + i + ';').join('\n') });
    return buildTypeContext({analysis, catalog: {declarationUris: new Set(), rolesByDeclaration: new Map(), analysisOnlyMacroUris: new Set()}});
  }
  test('does not rescan unrelated bindings for every expression', () => {
    const ctx = context();
    let reads = 0;
    for (const binding of ctx.bindings) {
      const name = binding.name;
      Object.defineProperty(binding, 'name', {get() { reads++; return name; }});
    }
    const scope = ctx.scopes[0];
    lookupBinding(ctx, 'value1', scope);
    lookupBinding(ctx, 'missing', scope);
    reads = 0;
    for (let i = 0; i < 30; i++) {
      assert.strictEqual(lookupBinding(ctx, 'value' + i, scope)?.name, 'value' + i);
      assert.strictEqual(lookupBinding(ctx, 'missing' + i, scope), undefined);
    }
    assert.ok(reads < 100, 'Repeated expressions reread ' + reads + ' binding names');
  });
  test('sees appended declarations after a miss and preserves position and last-declaration precedence', () => {
    const ctx = context();
    const scope = ctx.scopes[0];
    assert.strictEqual(lookupBinding(ctx, 'added', scope), undefined);
    const first: Binding = {...ctx.bindings[0], name: 'added', node: {...ctx.bindings[0].node, start: 10}};
    scope.bindings.push(first); ctx.bindings.push(first);
    assert.strictEqual(lookupBinding(ctx, 'added', scope, 9), undefined);
    assert.strictEqual(lookupBinding(ctx, 'added', scope, 10), first);
    const second: Binding = {...first, node: {...first.node, start: 20}};
    scope.bindings.push(second); ctx.bindings.push(second);
    assert.strictEqual(lookupBinding(ctx, 'added', scope, 19), first);
    assert.strictEqual(lookupBinding(ctx, 'added', scope, 20), second);
  });
});
