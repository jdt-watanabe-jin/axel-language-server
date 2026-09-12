import * as assert from 'assert';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectTypeDiagnostics } from '../../../analyzer/typeChecking/diagnostics';

suite('Type checking: function prototypes', () => {
  function check(text: string) {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri: 'file:///prototypes.axl', version: 1, text});
    assert.deepStrictEqual(analysis.diagnostics, []);
    return collectTypeDiagnostics({analysis});
  }

  test('accepts virtual member prototypes', () => {
    assert.deepStrictEqual(check('class A { int x; virtual void func(); };'), []);
  });

  test('accepts virtual callbacks with parameters and comments', () => {
    assert.deepStrictEqual(check('class A { int x; public: virtual /* callback */ void OnApply(); virtual\nvoid OnChangedName(string celname); };'), []);
  });

  test('still diagnoses non-virtual members beside virtual members', () => {
    const diagnostics = check('class A { int x; virtual void allowed();\nvoid rejected(); };');
    assert.deepStrictEqual(diagnostics.map(d => [d.code, d.range.start.line]), [['axel.type.prototype', 1]]);
  });

  test('still diagnoses ordinary member and free function prototypes', () => {
    for (const text of ['class A { int x; void func(); };', 'void func();', 'class A { int x; /* virtual */ void func(); };']) {
      assert.deepStrictEqual(check(text).map(d => d.code), ['axel.type.prototype']);
    }
  });
});
