import * as assert from 'assert';
import { findInnermostScope, contains, rangeSize } from '../../analyzer/resolution';
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
    for(let character=0;character<22;character++){
      const position={line:0,character};const expected=scopes.filter(scope=>contains(scope.range,position)).sort((a,b)=>rangeSize(a.range)-rangeSize(b.range))[0];
      assert.strictEqual(findInnermostScope(scopes,position),expected);
    }
  });
});
