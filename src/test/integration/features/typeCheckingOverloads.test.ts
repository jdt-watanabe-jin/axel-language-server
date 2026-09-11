import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Type checking: registered overloads and observed expression results', () => {
  const fixtures = useWorkspaceFixtures();
  function analyze(headerText: string, source: string) {
    const root = fixtures.createTempDir();
    const header = path.join(root, 'axel.h');
    fs.writeFileSync(header, headerText);
    fs.writeFileSync(path.join(root, 'axel.analysis.json'), JSON.stringify({
      schemaVersion: 1, profile: 'axel-510', declarationFiles: ['axel.h'],
      types: { natural: 'axel.h' }, analysisOnlyMacros: []
    }));
    const index = fixtures.createWorkspaceIndex({ forcedIncludeFiles: [header] });
    return index.analyzeDocument({ uri: pathToFileURL(path.join(root, 'probe.axl')).toString(), version: 1, text: source });
  }
  const natural = 'class natural {public:int value;};';
  test('accepts natural comparison as an if condition', () => {
    assert.deepStrictEqual(analyze(natural, 'void main(){natural n=2nat; if(n>=n){n=3nat;}}').diagnostics, []);
  });
  test('selects the nonfirst exact member overload', () => {
    const result = analyze(natural + 'class A {}; class API {public: int f(int); int f(A);};',
      'void main(){API api; A a; api.f(a);}');
    assert.deepStrictEqual(result.diagnostics, []);
  });
  test('defers unmeasured integer and float candidate ranking', () => {
    const result = analyze(natural + 'class API {public: int f(double); int *f(int);};',
      'void main(){API api; short s=1; int *p=api.f(s); float value=1.0; int *q=api.f(value);}');
    assert.deepStrictEqual(result.diagnostics, []);
  });
  test('selects the nonlast exact global overload', () => {
    const result = analyze(natural + 'class A {}; int *f(A); int f(int);',
      'void main(){A a; int *p=f(a);}');
    assert.deepStrictEqual(result.diagnostics, []);
  });
  test('defers unmeasured operator candidate ranking', () => {
    const result = analyze(natural + 'class API {public: int operator+(double); int *operator+(int);};',
      'void main(){API api; short value=1; int *p=api+value;}');
    assert.deepStrictEqual(result.diagnostics, []);
  });
  test('does not assume exact numeric match outranks other viable candidates', () => {
    const result = analyze(natural + 'class API {public: int f(int); int *f(double);};',
      'void main(){API api; int *p=api.f(1);}');
    assert.deepStrictEqual(result.diagnostics, []);
  });
  test('uses a common candidate result to diagnose the surrounding expression', () => {
    const result = analyze(natural + 'class API {public: int f(int,double); int f(double,int);};',
      'void main(){API api; short s=1; api.f(s,s);\nint *p=api.f(s,s);}');
    assert.deepStrictEqual(result.diagnostics.map(d => ({code: d.code, range: d.range})), [{
      code: 'axel.type.initialization',
      range: {start: {line: 1, character: 7}, end: {line: 1, character: 17}}
    }]);
  });
  for (const [expression, type] of [['n/2', 'natural'], ['n/2.0', 'natural'], ['n+2.0', 'double'], ['-n', 'natural'], ['+n', 'natural'], ['n+1', 'int'], ['n-1', 'int'], ['n*2.0', 'natural'], ['n<<1', 'int'], ['n>>1', 'int'], ['n%n', 'natural']]) {
    test(`uses measured result ${type} for ${expression}`, () => {
      const result = analyze(natural, `void main(){ natural n=2nat; void *p=${expression}; }`);
      const diagnostic = result.diagnostics.find(d => d.code === 'axel.type.initialization');
      assert.ok(diagnostic, JSON.stringify(result.diagnostics));
      assert.deepStrictEqual(diagnostic.messageDescriptor?.args, ['void*', type]);
      assert.strictEqual(result.diagnostics.length, 1, JSON.stringify(result.diagnostics));
      assert.ok(!result.diagnostics.some(d => d.code === 'axel.type.binary_operator' || d.code === 'axel.type.unary_operator'));
    });
  }
  test('checks compound division separately from binary division', () => {
    const result = analyze(natural, 'void main(){natural n=2nat; n/=n;}');
    assert.ok(result.diagnostics.some(d => d.code === 'axel.type.binary_operator'), JSON.stringify(result.diagnostics));
  });
  for (const expression of ['n<<n', 'n<<1.0', 'n&n', 'n|n', 'n^n', 'n<<=1', 'n<<=n', 'n%=1']) {
    test(`rejects measured unsupported operation ${expression}`, () => {
      const result = analyze(natural, `void main(){natural n=2nat; ${expression};}`);
      assert.ok(result.diagnostics.some(d => d.code === 'axel.type.binary_operator'), JSON.stringify(result.diagnostics));
    });
  }
});
