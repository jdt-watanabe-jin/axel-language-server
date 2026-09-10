import type * as Parser from 'tree-sitter';
import type { AnalysisDeclaration, AnalysisRange, AnalysisReference } from '../types/analysis';
import { findInnermostScope, isVisibleAt, contains } from './resolution';
import { buildScopeIndex } from './scopeIndex';
import { buildSymbolIndex } from './symbolIndex';
import { nodeToAnalysisRange } from './syntaxTree';
import { buildTypeSnapshot, type TypeNode } from './typeChecking/syntax';

/** T(*p) can be either a declaration or a call. Resolve names before choosing. */
export function resolveAmbiguousCalls(root: Parser.SyntaxNode, uri: string,
  declarations: AnalysisDeclaration[], excluded: readonly AnalysisRange[],
  parse: (text: string) => Parser.SyntaxNode): {range: AnalysisRange; node: TypeNode; references: AnalysisReference[]}[] {
  const candidates=root.descendantsOfType('object_definition').filter(node=>
    !node.hasError && node.namedChildCount === 2
    && node.childForFieldName('declarator')?.type === 'parenthesized_declarator');
  if (candidates.length === 0) { return []; }
  const active=declarations.filter(d=>!excluded.some(range=>contains(range,d.selectionRange.start)));
  const analysis={uri,declarations:active,scopes:buildScopeIndex(root,uri,active)};
  const result: {range: AnalysisRange; node: TypeNode; references: AnalysisReference[]}[]=[];
  for (const original of candidates) {
    if (original.hasError || original.namedChildCount !== 2) { continue; }
    let parent=original.parent;
    while (parent?.type.startsWith('preproc_')) { parent=parent.parent; }
    if (parent?.type !== 'compound_statement') { continue; }
    const type=original.childForFieldName('type');
    const declarator=original.childForFieldName('declarator');
    if (type?.type !== 'class_name' || declarator?.type !== 'parenthesized_declarator'
      || excluded.some(range=>contains(range,nodeToAnalysisRange(original).start))) { continue; }
    const positionInSource=nodeToAnalysisRange(type).start;
    let scope=findInnermostScope(analysis.scopes,positionInSource);
    let target: AnalysisDeclaration | undefined;
    while (scope && !target) {
      target=active.filter(d=>scope!.declarationIds.includes(d.id) && d.name===type.text
        && (['function','method'].includes(d.kind) || isVisibleAt(d,positionInSource,uri))).at(-1);
      scope=analysis.scopes.find(candidate=>candidate.id===scope!.parentId);
    }
    if (!target || !['function','method'].includes(target.kind)) { continue; }
    // Use Tree-sitter's expression grammar; do not reconstruct pointer operators.
    const prefix='void __call_probe(){return ';
    const text=prefix+original.text+'}';
    const parsed=parse(text);
    const statement=parsed.descendantsOfType('return_statement')[0];
    if (parsed.hasError || statement?.firstNamedChild?.type !== 'call_expression') { continue; }
    const shift=original.startIndex-prefix.length;
    const position=(index: number) => {
      const lines=root.text.slice(0,index).split('\n');
      return {line:lines.length-1,character:lines.at(-1)!.length};
    };
    const rebase=(node: TypeNode): TypeNode=>({...node,start:node.start+shift,end:node.end+shift,
      range:{start:position(node.start+shift),end:position(node.end+shift)},
      children:node.children.map(rebase),
      fields:Object.fromEntries(Object.entries(node.fields).map(([key,nodes])=>[key,nodes.map(rebase)]))});
    const node=rebase(buildTypeSnapshot(statement,uri).root);
    node.kind='expression_statement';node.text=original.text;node.start=original.startIndex;node.range=nodeToAnalysisRange(original);
    const index=(point: {line:number;character:number})=>text.split('\n').slice(0,point.line)
      .reduce((sum,line)=>sum+line.length+1,0)+point.character+shift;
    const references=buildSymbolIndex(statement,uri).references.map(ref=>({...ref,
      range:{start:position(index(ref.range.start)),end:position(index(ref.range.end))}}));
    result.push({range:node.range,node,references});
  }
  return result;
}
