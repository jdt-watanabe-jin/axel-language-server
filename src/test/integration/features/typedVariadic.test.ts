import * as assert from 'assert';
import { useWorkspaceFixtures } from '../../support/workspace';
import { acceptedArgumentCounts } from '../../../analyzer/resolution';

suite('Typed variadic arguments', () => {
  const fixtures=useWorkspaceFixtures();
  function check(call:string, signature='Item *parent, string text, string ...') {
    return fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///variadic.axl',version:1,
      text:`class Item { int x; static Item *Add(${signature}) {return NULL;} }; void f(Item *p){ ${call} }`});
  }
  for(const call of ['Item::Add(p,"A");','Item::Add(p,"A","B","C");']) {
    test('accepts '+call,()=>assert.deepStrictEqual(check(call).diagnostics,[]));
  }
  test('requires the fixed arguments',()=>{
    assert.ok(check('Item::Add(p);').diagnostics.some(d=>d.message.includes("Function 'Add' expects at least 2 arguments")));
  });
  test('keeps the typed ellipsis together in the signature',()=>{
    const a=check(''); const d=a.declarations.find(d=>d.name==='Add')!;
    assert.deepStrictEqual(d.signature!.parameters.map(p=>p.label),['Item *parent','string text','string ...']);
  });
  test('accepts zero arguments when only a typed variadic parameter is declared',()=>{
    const a=fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///log.axl',version:1,
      text:'void log(string ...){ } void f(){ log(); log("A"); log("A","B"); }'});
    assert.deepStrictEqual(a.diagnostics,[]);
  });
  test('still checks fixed arguments in the type checker',()=>{
    const a=fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///log.axl',version:1,
      text:'void log(int fixed, string ...){ } void f(){ log(); }'});
    assert.ok(a.diagnostics.some(d=>d.code==='axel.type.argument_type'));
  });
  test('accepts comments between the variadic type and ellipsis',()=>{
    assert.deepStrictEqual(check('Item::Add(p,"A");','Item *parent, string text, string /* tail */ ...').diagnostics,[]);
  });
  test('retains a comma-separated unnamed fixed parameter',()=>{
    const a=check('', 'Item *parent, string, ...');
    assert.strictEqual(acceptedArgumentCounts(a.declarations.find(d=>d.name==='Add')!).min,2);
  });
});
