import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Type checking: context invalidation', () => {
  const fixtures=useWorkspaceFixtures();
  function setup() {
    const root=fixtures.createTempDir();
    const header=path.join(root,'builtin.h');
    const manifest=path.join(root,'builtin.analysis.json');
    fs.writeFileSync(header,'class natural {int value;}; class string {int value;};');
    fs.writeFileSync(manifest,JSON.stringify({schemaVersion:1,profile:'axel-510',
      declarationFiles:['builtin.h'],types:{natural:'builtin.h',string:'builtin.h'},analysisOnlyMacros:[]}));
    const index=fixtures.createWorkspaceIndex({forcedIncludeFiles:[header],includeRoots:[root]});
    const uri=pathToFileURL(path.join(root,'main.axl')).toString();
    const check=(text:string,version=1)=>index.analyzeDocument({uri,version,text}).diagnostics.filter(d=>d.code?.startsWith('axel.type.'));
    return {root,header,manifest,index,uri,check};
  }
  test('manifest role changes invalidate unchanged source versions',()=>{
    const f=setup(); const source='void main(){natural n; n*1;}';
    assert.deepStrictEqual(f.check(source),[]);
    fs.writeFileSync(f.manifest,JSON.stringify({schemaVersion:1,profile:'axel-510',declarationFiles:['builtin.h'],types:{},analysisOnlyMacros:[]}));
    f.index.invalidateUri(pathToFileURL(f.manifest).toString());
    assert.ok(f.check(source).some(d=>d.code==='axel.type.binary_operator'));
  });
  test('included function result changes invalidate dependent type diagnostics',()=>{
    const f=setup(); const header=path.join(f.root,'value.h');
    fs.writeFileSync(header,'int value(){return 1;}');
    const source='#include "value.h"\nvoid main(){int i=value();}';
    assert.deepStrictEqual(f.check(source),[]);
    fs.writeFileSync(header,'string value(){return "x";}');
    f.index.invalidateUri(pathToFileURL(header).toString());
    assert.ok(f.check(source).some(d=>d.code==='axel.type.initialization'));
  });
  test('inactive declarations and functions do not leak',()=>{
    const f=setup();
    assert.deepStrictEqual(f.check('#if 0\nvoid f(){}\nclass A {int x;}; A a;\n#endif\nvoid f(){int b=1;b=a;}'),[]);
  });
  test('nested switch cases belong to their nearest switch',()=>{
    const f=setup();
    assert.deepStrictEqual(f.check('void main(){switch("x"){case "x":switch(1){case 1:break;}}}'),[]);
  });
  test('source macro override invalidates cached NULL provenance',()=>{
    const f=setup();
    assert.deepStrictEqual(f.check('void main(){int*p=NULL;}'),[]);
    assert.ok(f.check('#define NULL 0\nvoid main(){int*p=NULL;}',2).some(d=>d.code==='axel.type.initialization'));
  });
  test('an included undef removes an earlier source NULL override',()=>{
    const f=setup();
    fs.writeFileSync(path.join(f.root,'reset.h'),'#undef NULL\n');
    assert.deepStrictEqual(f.check('#define NULL 0\n#include "reset.h"\nvoid main(){int*p=NULL;}'),[]);
  });
  test('an inactive included undef preserves an earlier override',()=>{
    const f=setup();
    fs.writeFileSync(path.join(f.root,'reset.h'),'#if 0\n#undef NULL\n#endif\n');
    assert.ok(f.check('#define NULL 0\n#include "reset.h"\nvoid main(){int*p=NULL;}').some(d=>d.code==='axel.type.initialization'));
  });

  test('composes sizeof constants without inventing their numeric size',()=>{
    const f=setup();
    assert.deepStrictEqual(f.check('void main(){int a[sizeof(int)+1]; int b[+sizeof(int)];}'),[]);
  });

});
