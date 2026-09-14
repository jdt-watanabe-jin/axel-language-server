import { mock } from 'node:test';
import { descendants, field } from '../../../analyzer/typeChecking/syntax';
import * as assert from 'assert';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { loadBuiltinCatalog } from '../../../analyzer/typeChecking/builtinCatalog';
import { buildTypeContext, lookupBinding, lookupClass, resolveType } from '../../../analyzer/typeChecking/declarations';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';

suite('Type checking: declaration resolution', () => {
  function analyze(text: string) {
    return new DocumentAnalyzer().analyzeDocument({uri:'file:///declarations.axl',version:1,text});
  }
  test('does not probe unrelated header scopes for an absent type alias', () => {
    const analyzer = new DocumentAnalyzer();
    const documents = Array.from({length: 100}, (_, n) => analyzer.analyzeDocument({
      uri: 'file:///header' + n + '.h', version: 1, text: 'typedef int Alias' + n + ';' }));
    const analysis = analyze('Missing value;');
    const ctx = buildTypeContext({analysis, documents, catalog:loadBuiltinCatalog([])});
    const node = field(descendants(analysis.typeSnapshot!.root, 'object_definition')[0], 'type')!;
    const spy = mock.method(ctx.aliases, 'get', ctx.aliases.get.bind(ctx.aliases));
    try {
      assert.strictEqual(resolveType(ctx, node, ctx.nodeScopes.get(node)!).kind, 'unknown');
      assert.ok(spy.mock.callCount() <= 2, 'must not look up the name in every included header');
    } finally { spy.mock.restore(); }
  });

  test('preserves alias precedence, local shadowing and declaration order', () => {
    const analyzer = new DocumentAnalyzer();
    for (const [version, type] of [[1, 'short'], [2, 'double']] as const) {
      const documents = [
        analyzer.analyzeDocument({uri:'file:///first.h',version,text:'typedef ' + type + ' Shared;'}),
        analyzer.analyzeDocument({uri:'file:///second.h',version,text:'typedef long Shared;'})
      ];
      const analysis = analyze('Shared imported; void main(){ typedef int Shared; Shared inner; }\nShared after; Later early; typedef int Later; Later late;');
      const ctx = buildTypeContext({analysis,documents,catalog:loadBuiltinCatalog([])});
      const types = Object.fromEntries(ctx.bindings.map(binding => [binding.name,binding.type.name]));
      assert.strictEqual(types.imported,type);
      assert.strictEqual(types.inner,'int');
      assert.strictEqual(types.after,type);
      assert.strictEqual(ctx.bindings.find(binding => binding.name === 'early')?.type.kind,'unknown');
      assert.strictEqual(types.late,'int');
    }
  });

  test('does not chain user conversions to double or use them for initialization', () => {
    const text='class A {int data; operator int(){return 0;}};\nvoid take(double value){}\nvoid main(){A a; take(a); int i=a;}';
    const diagnostics=new WorkspaceIndex().analyzeDocument({uri:'file:///conversion.axl',version:1,text}).diagnostics;
    assert.deepStrictEqual(diagnostics.map(d=>({code:d.code,range:d.range})), [
      {code:'axel.type.argument_type',range:{start:{line:2,character:22},end:{line:2,character:23}}},
      {code:'axel.type.initialization',range:{start:{line:2,character:32},end:{line:2,character:33}}}
    ]);
  });
  test('inactive declarations and classes never enter the type context', () => {
    const analysis=analyze('#if 0\nclass natural {int x;}; natural hidden; void hiddenFn(){}\n#endif\nclass natural {short x;}; natural visible;');
    const ctx=buildTypeContext({analysis,catalog:loadBuiltinCatalog([])});
    assert.strictEqual(ctx.classes.length,1);
    assert.strictEqual(lookupClass(ctx,'natural',ctx.scopes[0])!.fields.get('x')!.type.name,'short');
    assert.strictEqual(lookupBinding(ctx,'hidden',ctx.scopes[0]),undefined);
    assert.ok(!ctx.functions.some(f=>f.name==='hiddenFn'));
  });
  test('uncertain declarations and named types remain unresolved', () => {
    const analysis=analyze('class A {int x;};\nA a;');
    analysis.uncertainRanges=[{start:{line:0,character:0},end:{line:1,character:0}}];
    analysis.uncertainNames=['A'];
    const ctx=buildTypeContext({analysis,catalog:loadBuiltinCatalog([])});
    assert.strictEqual(ctx.classes.length,0);
    assert.strictEqual(lookupBinding(ctx,'a',ctx.scopes[0])!.type.kind,'unknown');
    const other=analyze('class A {int x;}; A a;'); other.uncertainNames=['A'];
    const otherCtx=buildTypeContext({analysis:other,catalog:loadBuiltinCatalog([])});
    assert.strictEqual(lookupBinding(otherCtx,'a',otherCtx.scopes[0])!.type.kind,'unknown');
  });
  test('value multiplication creates no phantom binding while real pointers survive', () => {
    const ctx=buildTypeContext({analysis:analyze('class A {int x;}; void main(){ int a; int b; a*b; A *p; }'),catalog:loadBuiltinCatalog([])});
    const fn=ctx.functions.find(f=>f.name==='main')!;
    assert.strictEqual(ctx.bindings.filter(b=>b.name==='b').length,1);
    assert.strictEqual(lookupBinding(ctx,'b',fn.scope)!.type.name,'int');
    assert.strictEqual(lookupBinding(ctx,'p',fn.scope)!.type.kind,'pointer');
  });
});
