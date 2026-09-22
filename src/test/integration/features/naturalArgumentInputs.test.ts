import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';
suite('Natural argument input forms', () => {
  const fixtures=useWorkspaceFixtures();
  test('accepts integer literals, variables and expressions as natural arguments', () => {
    const root=fixtures.createTempDir(), header=path.join(root,'builtin.h');
    fs.writeFileSync(header,'class natural {public:int value;};');
    fs.writeFileSync(path.join(root,'builtin.analysis.json'),JSON.stringify({schemaVersion:1,profile:'axel-510',declarationFiles:['builtin.h'],types:{natural:'builtin.h'},analysisOnlyMacros:[]}));
    const index=fixtures.createWorkspaceIndex({forcedIncludeFiles:[header]});
    assert.deepStrictEqual(index.analyzeDocument({uri:pathToFileURL(path.join(root,'main.axl')).toString(),version:1,text:'void f(natural value){} void main(){int i=1; f(1); f(i); f(i+1);}'}).diagnostics,[]);
  });
});
