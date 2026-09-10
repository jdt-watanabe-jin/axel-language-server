import type * as Parser from 'tree-sitter';
import type { AnalysisMacroDefinition, AnalysisRange, AnalysisReference } from '../types/analysis';
import { createMacroLookup } from './diagnostics';
import { expandObjectMacroText } from './macroExpansion';
import { comparePositions, contains } from './resolution';
import { buildSymbolIndex } from './symbolIndex';
import { nodeToAnalysisRange } from './syntaxTree';
import { buildTypeSnapshot, type TypeNode } from './typeChecking/syntax';

export interface RecoveredMacroCommand {
  range: AnalysisRange;
  node: TypeNode;
  references: AnalysisReference[];
}

/** Reparse only a macro-prefixed statement, preserving source locations in its unchanged suffix. */
export function recoverMacroCommands(root: Parser.SyntaxNode, uri: string,
  macros: readonly AnalysisMacroDefinition[], excluded: readonly AnalysisRange[],
  parse: (text: string) => Parser.SyntaxNode): RecoveredMacroCommand[] {
  const result: RecoveredMacroCommand[] = [];
  const undefs = root.descendantsOfType('preproc_call').filter(node =>
    node.childForFieldName('directive')?.text.trim() === '#undef'
    && !excluded.some(range => contains(range,nodeToAnalysisRange(node).start)));
  for (const original of root.descendantsOfType('object_definition')) {
    const type = original.childForFieldName('type');
    if (!type || !original.hasError || excluded.some(range => contains(range,nodeToAnalysisRange(original).start))) { continue; }
    const start = nodeToAnalysisRange(type).start;
    const visible = createMacroLookup(macros,uri,start);
    const lookup = {findMacro: (name: string) => {
      const macro = visible.findMacro(name);
      if (!macro) { return undefined; }
      const origin = macro.visibilityStart ?? (macro.uri === uri ? macro.range.end : {line:0,character:0});
      return undefs.some(node => node.childForFieldName('argument')?.text.trim() === name
        && node.startIndex < original.startIndex && comparePositions(nodeToAnalysisRange(node).start,origin) >= 0)
        ? undefined : macro;
    }};
    const macro = lookup.findMacro(type.text);
    if (!macro || macro.parameters !== undefined) { continue; }
    const expansion = expandObjectMacroText(type.text,lookup);
    if (expansion.truncated || expansion.diagnostics.length || !expansion.expandedText.trimStart().startsWith('@')) { continue; }
    const wrapper = 'void __command_probe(){';
    const tail = original.text.slice(type.endIndex-original.startIndex);
    const prefix = wrapper + expansion.expandedText;
    const parsed = parse(prefix+tail+'}');
    const commands = parsed.descendantsOfType('command_statement');
    if (parsed.hasError || commands.length !== 1) { continue; }
    const command = commands[0];
    const offset = (index: number): number => index < prefix.length ? type.startIndex : type.endIndex+index-prefix.length;
    const position = (index: number) => {
      const before = root.text.slice(0,index).split('\n');
      return {line:before.length-1,character:before.at(-1)!.length};
    };
    const rebase = (node: TypeNode): TypeNode => ({...node,
      start:offset(node.start),end:offset(node.end),range:{start:position(offset(node.start)),end:position(offset(node.end))},
      children:node.children.map(rebase),
      fields:Object.fromEntries(Object.entries(node.fields).map(([key,nodes])=>[key,nodes.map(rebase)]))});
    const snapshot = rebase(buildTypeSnapshot(command,uri).root);
    snapshot.start=original.startIndex; snapshot.end=original.endIndex; snapshot.range=nodeToAnalysisRange(original);
    const toIndex = (point: {line:number;character:number}): number => {
      const lines=(prefix+tail+'}').split('\n');
      return lines.slice(0,point.line).reduce((sum,line)=>sum+line.length+1,0)+point.character;
    };
    const references = buildSymbolIndex(command,uri).references
      .filter(ref=>toIndex(ref.range.start)>=prefix.length)
      .map(ref=>({...ref,range:{start:position(offset(toIndex(ref.range.start))),end:position(offset(toIndex(ref.range.end)))}}));
    references.unshift({name:type.text,uri,range:nodeToAnalysisRange(type)});
    result.push({range:snapshot.range,node:snapshot,references});
  }
  return result;
}
