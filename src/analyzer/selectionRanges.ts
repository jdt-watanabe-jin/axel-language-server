import type * as Parser from 'tree-sitter';
import type { AnalysisPosition, AnalysisRange } from '../types/analysis';
import type { AnalysisStep } from '../util/analysisSteps';
import { nodeToAnalysisRange } from './syntaxTree';
import { rangeContains } from './navigationTargets';
export interface AnalysisSelectionRange { range:AnalysisRange; parent?:AnalysisSelectionRange }
export function* collectSelectionRangesSteps(root:Parser.SyntaxNode,positions:readonly AnalysisPosition[],text:string):Generator<AnalysisStep,AnalysisSelectionRange[],void> {
  const lengths=text.split('\n').map(line=>line.endsWith('\r')?line.length-1:line.length);
  const normalize=(range:AnalysisRange):AnalysisRange=>({start:{...range.start,character:Math.min(range.start.character,lengths[range.start.line]??0)},end:{...range.end,character:Math.min(range.end.character,lengths[range.end.line]??0)}});
  const results:AnalysisSelectionRange[]=[];
  for(const position of positions){
    yield;
    const point={row:position.line,column:position.character};
    const zero={start:position,end:position};
    const ranges:AnalysisRange[]=[];
    if(rangeContains(nodeToAnalysisRange(root),zero)){
      let node:Parser.SyntaxNode|null=root.descendantForPosition(point);
      while(node){
        const range=normalize(nodeToAnalysisRange(node));
        if(rangeContains(range,zero)&&!node.isMissing&&(!ranges.length||JSON.stringify(ranges.at(-1))!==JSON.stringify(range)))ranges.push(range);
        node=node.parent;
      }
    }
    if(!ranges.length)ranges.push(zero);
    let item:AnalysisSelectionRange|undefined;
    for(let i=ranges.length-1;i>=0;i--)item={range:ranges[i],...(item?{parent:item}:{})};
    results.push(item!);
  }
  return results;
}
