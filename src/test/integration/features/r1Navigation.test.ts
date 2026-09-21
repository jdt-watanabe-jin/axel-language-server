import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';
import { positionFromOffset } from '../../support/source';
import { getDeclarations, getTypeDefinitions } from '../../../analyzer/navigationTargets';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
const {createWorkspaceIndex,createTempDir}=useWorkspaceFixtures();
suite('R1 static navigation',()=>{
  function fixture(text:string){const index=createWorkspaceIndex();const uri=pathToFileURL(path.join(createTempDir(),'main.axl')).toString();const analysis=index.indexOpenDocument({uri,version:1,text});return {index,analysis,at:(name:string,last=false)=>({analysis,workspaceIndex:index,position:positionFromOffset(text,last?text.lastIndexOf(name):text.indexOf(name))})};}
  test('nearest aliases at type-name uses, basic aliases and alias declarations',()=>{
    const f=fixture('class Value {};\ntypedef Value Alias;\nAlias item;\ntypedef int Count;\nCount count;');
    assert.strictEqual(getTypeDefinitions(f.at('Alias',true))[0]?.range.start.line,1);
    assert.strictEqual(getTypeDefinitions(f.at('Alias'))[0]?.range.start.line,0);
    assert.strictEqual(getTypeDefinitions(f.at('count'))[0]?.range.start.line,3);
    assert.deepStrictEqual(getTypeDefinitions(f.at('Count')),[]);
  });
  test('parameters, reference/array shapes, fields and GUI parts',()=>{
    const f=fixture('class Value {}; class Holder { Value field; }; Holder h;\nvoid work(Value &arg) { arg; h.field; }\nValue *items[2];\nclass GCWidget {}; class GCDialog : GCWidget {}; class GCCheckBox : GCWidget {};\nclass Dialog : GCDialog { GCCheckBox check {}; };');
    for(const word of ['arg','field','items'])assert.strictEqual(getTypeDefinitions(f.at(word,true))[0]?.range.start.line,0,word);
    assert.strictEqual(getTypeDefinitions(f.at('check'))[0]?.range.start.line,3);
  });
  test('returns empty for comments, builtin, function pointers, unknown and inactive declarations',()=>{
    const f=fixture('class Value {};\nint number; Missing unresolved; Value (*callback)();\n#if 0\nValue hidden;\n#endif\n// Value comment');
    for(const word of ['number','unresolved','callback','hidden','Value comment'])assert.deepStrictEqual(getTypeDefinitions(f.at(word)),[],word);
  });
  test('preserves lexical scopes and prefers class forward declarations',()=>{
    const f=fixture('class Value;\nclass Value { int x; };\nvoid first() { class Local {}; Local a; }\nvoid second() { class Local {}; Local b; }');
    assert.strictEqual(getDeclarations(f.at('Value',true))[0]?.range.start.line,0);
    assert.strictEqual(getTypeDefinitions(f.at('a;'))[0]?.range.start.line,2);
    assert.strictEqual(getTypeDefinitions(f.at('b;'))[0]?.range.start.line,3);
  });
  test('does not select ambiguous types from separate visible headers',()=>{
    const root=createTempDir();fs.writeFileSync(path.join(root,'a.h'),'class Value {};');fs.writeFileSync(path.join(root,'b.h'),'class Value { int x; };');
    const index=createWorkspaceIndex();const text='#include "a.h"\n#include "b.h"\nValue value;';const analysis=index.indexOpenDocument({uri:pathToFileURL(path.join(root,'main.axl')).toString(),version:1,text});
    assert.deepStrictEqual(getTypeDefinitions({analysis,workspaceIndex:index,position:positionFromOffset(text,text.indexOf('value'))}),[]);
  });
  test('selects original comments, strings and unfinished syntax with UTF-16 positions',()=>{
    const analyzer=new DocumentAnalyzer();const text='// astral \uD83D\uDE00\r\nvoid main() { string s = "hello"; if (s';
    const positions=[{line:0,character:11},{line:1,character:28},{line:1,character:37}];
    const result=runAnalysisSteps(analyzer.getSelectionRangesSteps({uri:'file:///selection.axl',version:1,text},positions));assert.strictEqual(result.length,3);
    assert.strictEqual(result[0].range.start.line,0);assert.strictEqual(result[0].range.end.character,12);
    for(const selection of result){let item=selection;while(item.parent){assert.notDeepStrictEqual(item.range,item.parent.range);item=item.parent;}}
  });
});
