import * as assert from 'assert';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectTypeDiagnostics } from '../../../analyzer/typeChecking/diagnostics';
import { loadBuiltinCatalog } from '../../../analyzer/typeChecking/builtinCatalog';

suite('Type checking: uncertain expression bindings', () => {
  const uri = 'file:///D:/uncertainty.axl';
  function check(text: string) {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri,version:1,text});
    return collectTypeDiagnostics({analysis});
  }
  test('defers a previous macro when an uncertain later definition can override it', () => {
    assert.deepStrictEqual(check('class A {int value;}; A a;\n#define X a\n#if __TIME__\n#define X 1\n#endif\nvoid main(){int i=X;}'), []);
  });
  test('defers a previous variable when an uncertain declaration can override it', () => {
    assert.deepStrictEqual(check('class A {int value;}; A a;\n#if __TIME__\nint a;\n#endif\nvoid main(){int i=a;}'), []);
  });
  test('keeps a definite later macro replacement known', () => {
    const diagnostics = check('class A {int value;}; A a;\n#define X 1\n#if __TIME__\n#define X 2\n#endif\n#define X a\nvoid main(){int i=X;}');
    assert.ok(diagnostics.some(d=>d.code==='axel.type.initialization'));
  });
  test('does not let another block or a later declaration silence known mismatches', () => {
    assert.ok(check('class A {int value;}; A a; void other(){\n#if __TIME__\nint a;\n#endif\n}\nvoid main(){int i=a;}').some(d=>d.code==='axel.type.initialization'));
    assert.ok(check('class A {int value;}; A a; void main(){int i=a;\n#if __TIME__\nint a;\n#endif\n}').some(d=>d.code==='axel.type.initialization'));
  });
  test('a definite inner binding shadows an uncertain outer declaration', () => {
    assert.ok(check('class A {int value;}; A a;\n#if __TIME__\nint a;\n#endif\nvoid main(){A a;int i=a;}').some(d=>d.code==='axel.type.initialization'));
  });
  test('defers imported uncertain names when exact candidates are unavailable', () => {
    const analyzer = new DocumentAnalyzer();
    const header = analyzer.analyzeDocument({uri:'file:///D:/header.h',version:1,text:'class A {int value;}; A external;'});
    const analysis = analyzer.analyzeDocument({uri,version:1,text:'void main(){int i=external;}',uncertainNames:['external']});
    assert.deepStrictEqual(collectTypeDiagnostics({analysis,documents:[header]}), []);
  });
  test('nested function-like macro expansion respects uncertain replacements', () => {
    assert.deepStrictEqual(check('class A {int value;}; A a;\n#define X a\n#define ID(v) v\n#if __TIME__\n#define X 1\n#endif\nvoid main(){int i=ID(X);}'), []);
  });
  test('uses system macro types without inventing runtime values', () => {
    assert.ok(check('void main(){int*p=__LINE__;}').some(d=>d.code==='axel.type.initialization'));
    const analyzer = new DocumentAnalyzer();
    const headerUri = 'file:///D:/system-header.h';
    const header = analyzer.analyzeDocument({uri:headerUri,version:1,text:'class string {};'});
    const analysis = analyzer.analyzeDocument({uri,version:1,text:'void main(){int i=__TIME__; int a[__LINE__]; int*p=__APP_LEDIT__;}'});
    const catalog = loadBuiltinCatalog([]);
    const diagnostics = collectTypeDiagnostics({analysis,documents:[header],catalog:{...catalog,rolesByDeclaration:new Map([[headerUri+'#string','string']])}});
    assert.strictEqual(diagnostics.length,1);
    assert.strictEqual(diagnostics[0].code,'axel.type.initialization');
  });
});
