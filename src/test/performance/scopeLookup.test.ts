import * as assert from 'assert';
import { findInnermostScope } from '../../analyzer/resolution';
import type { AnalysisScope } from '../../types/analysis';
suite('Scope lookup performance',()=>{
  test('avoids scanning unrelated scopes for each reference',()=>{
    let reads=0;
    const scopes:AnalysisScope[]=Array.from({length:10000},(_,i)=>({id:String(i),declarationIds:[],range:{get start(){reads++;return {line:i*2,character:0};},end:{line:i*2+1,character:0}}}));
    assert.strictEqual(findInnermostScope(scopes,{line:12000,character:1})?.id,'6000');
    reads=0;
    assert.strictEqual(findInnermostScope(scopes,{line:6000,character:1})?.id,'3000');
    assert.ok(reads<50,`Read ${reads} unrelated range starts`);
  });
  test('preserves overlapping ranges, tie order and end-exclusive boundaries',()=>{
    const ranges=[[0,20],[2,8],[2,8],[4,12],[6,7],[14,14]];
    const scopes:AnalysisScope[]=ranges.map(([start,end],i)=>({id:String(i),declarationIds:[],range:{start:{line:0,character:start},end:{line:0,character:end}}}));
    for (const [character, expected] of [[0,'0'],[2,'1'],[4,'1'],[6,'4'],[7,'1'],[8,'3'],[12,'0'],[14,'0'],[19,'0'],[20,undefined]] as const) {
      assert.strictEqual(findInnermostScope(scopes,{line:0,character})?.id,expected);
    }
  });
});
