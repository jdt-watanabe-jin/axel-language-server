import * as assert from 'assert';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { buildTypeContext, lookupBinding } from '../../analyzer/typeChecking/declarations';

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
  test('sees appended parsed declarations after a miss and preserves source precedence', () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri:'file:///appended.axl',version:1,text:'int added;\nstring added;'});
    const ctx = buildTypeContext({analysis,catalog:{declarationUris:new Set(),rolesByDeclaration:new Map(),analysisOnlyMacroUris:new Set()}});
    const scope = ctx.scopes[0];
    const [first, second] = scope.bindings.filter(binding => binding.name === 'added');
    assert.ok(first); assert.ok(second);
    // Context construction appends bindings; prime a miss before replaying the real parsed entries.
    scope.bindings.length = 0;
    assert.strictEqual(lookupBinding(ctx,'added',scope),undefined);
    scope.bindings.push(first);
    assert.strictEqual(lookupBinding(ctx,'added',scope,first.node.start-1),undefined);
    assert.strictEqual(lookupBinding(ctx,'added',scope,first.node.start),first);
    scope.bindings.push(second);
    assert.strictEqual(lookupBinding(ctx,'added',scope,second.node.start-1),first);
    assert.strictEqual(lookupBinding(ctx,'added',scope,second.node.start),second);
  });
});
