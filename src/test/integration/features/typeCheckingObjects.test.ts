import * as assert from 'assert';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectTypeDiagnostics } from '../../../analyzer/typeChecking/diagnostics';

suite('Type checking: object instantiation',()=>{
  function check(text:string) {
    return collectTypeDiagnostics({analysis:new DocumentAnalyzer().analyzeDocument({uri:'file:///objects.axl',version:1,text})});
  }
  for (const body of ['', 'int method(){return 1;}', 'A operator=(int v){return *this;}']) {
    test(`diagnoses empty storage at declaration, not assignment: ${body}`,()=>{
      const diagnostics=check(`class A {public:${body}};\nvoid main(){ A a; }`);
      assert.strictEqual(diagnostics.length,1);
      assert.strictEqual(diagnostics[0].code,'axel.type.object_type');
      assert.deepStrictEqual(diagnostics[0].range,{start:{line:1,character:15},end:{line:1,character:16}});
    });
  }
  test('accepts the same assignment when instance data is inherited',()=>{
    assert.deepStrictEqual(check('class B {public:int value;}; class A:public B {public:A operator=(int v){return *this;}}; void main(){A a;a=1;}'),[]);
  });
  test('class declarations, pointers and parameters do not instantiate an empty object',()=>{
    assert.deepStrictEqual(check('class A {}; void f(A value){} void main(){A*p;}'),[]);
  });
  test('empty-class arrays require instance data',()=>{
    assert.ok(check('class A {}; void main(){A a[2];}').some(d=>d.code==='axel.type.object_type'));
  });
  test('uncertain instance fields prevent a speculative empty-class error',()=>{
    assert.deepStrictEqual(check('class A {\n#if __TIME__\nint member;\n#endif\n}; void main(){A a;}'),[]);
  });

});
