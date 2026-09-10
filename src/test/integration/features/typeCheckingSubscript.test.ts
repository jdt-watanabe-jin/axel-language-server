import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Type checking: declared subscript operators', () => {
  const fixtures=useWorkspaceFixtures();
  function check(body: string, declarations = '') {
    const root=fixtures.createTempDir();
    const header=path.join(root,'builtin.h');
    fs.writeFileSync(header, `class VARRAY {public: int Add(any value); any* GetAt(int index); any* operator[](int index);};
      class string {int value;};` + declarations);
    fs.writeFileSync(path.join(root,'builtin.analysis.json'),JSON.stringify({schemaVersion:1,profile:'axel-510',
      declarationFiles:['builtin.h'],types:{VARRAY:'builtin.h',string:'builtin.h'},analysisOnlyMacros:[]}));
    return fixtures.createWorkspaceIndex({forcedIncludeFiles:[header]}).analyzeDocument({
      uri:'file:///subscript.axl',version:1,text:`void main(){${body}}`
    }).diagnostics.filter(d=>d.code?.startsWith('axel.type.'));
  }
  test('accepts VARRAY subscript access through an explicit element pointer cast', () => {
    assert.deepStrictEqual(check('VARRAY v;v.Add(5);int n=*(int*)v[0];'), []);
  });
  test('does not assume all VARRAY instances contain integers', () => {
    assert.deepStrictEqual(check('VARRAY a;a.Add(5);VARRAY b;b.Add("x");string s=*(string*)b[0];'), []);
  });
  test('keeps a by-value subscript result nonassignable', () => {
    const diagnostics=check('VARRAY v;v[0]=NULL;');
    assert.deepStrictEqual(diagnostics.map(d=>d.code), ['axel.type.assignment']);
  });
  test('preserves declared numeric result types for other classes', () => {
    const diagnostics=check('Numbers v;int*p=v[0];','class Numbers {public:int operator[](int i);};');
    assert.deepStrictEqual(diagnostics.map(d=>d.code), ['axel.type.initialization']);
  });
  test('uses inherited subscript declarations', () => {
    assert.deepStrictEqual(check('Child v;int n=v[0];','class Base {public:int operator[](int i);}; class Child:public Base {};'), []);
  });
  test('rejects floating-point indices for registered VARRAY', () => {
    assert.deepStrictEqual(check('VARRAY v;v[0.0];').map(d=>d.code), ['axel.type.subscript']);
  });
  test('still rejects subscripting classes without an operator', () => {
    assert.deepStrictEqual(check('Other v;v[0];','class Other {};').map(d=>d.code), ['axel.type.subscript']);
  });
});
