import type * as Parser from 'tree-sitter';
import type { AnalysisMacroDefinition, AnalysisRange, AnalyzedDocument } from '../types/analysis';
import { comparePositions, contains } from './resolution';
import { nodeToAnalysisRange } from './syntaxTree';
import { isSystemMacroName } from './systemMacros';
import { rangeKey } from './documentHighlightAccess';
import { preprocessorUndefinition } from './preprocessorEvaluation';
import type { AnalysisStep } from '../util/analysisSteps';

/** The evaluator supplies activity; this pass only binds source spellings to active definitions. */
export function* collectHighlightMacrosSteps(root: Parser.SyntaxNode, analysis: AnalyzedDocument,
  definitions: readonly AnalysisMacroDefinition[], skippedConditions: AnalysisRange[]): Generator<AnalysisStep, NonNullable<AnalyzedDocument['highlightMacros']>, void> {
  yield;
  const result: NonNullable<AnalyzedDocument['highlightMacros']> = [];
  const excluded = [...analysis.inactiveRanges ?? [],...analysis.uncertainRanges ?? [],...skippedConditions];
  const suppressed = (node: Parser.SyntaxNode) => excluded.some(range=>contains(range,nodeToAnalysisRange(node).start));
  const key = (macro: AnalysisMacroDefinition) => `macro:${macro.uri}:${rangeKey(macro.selectionRange)}:${macro.name}`;
  const undefs = root.descendantsOfType('preproc_call').flatMap(node=> {
    const event = preprocessorUndefinition(node);
    return event && !suppressed(node) ? [{...event,startIndex:node.startIndex}] : [];
  });
  const byName = new Map<string,AnalysisMacroDefinition[]>();
  for (const macro of definitions) {
    if (isSystemMacroName(macro.name)) { continue; }
    const items = byName.get(macro.name) ?? [];
    items.push(macro); byName.set(macro.name,items);
    if (macro.uri === analysis.uri) { result.push({range:macro.selectionRange,target:key(macro)}); }
  }
  if (!byName.size) { return []; }
  const invocationStarts = new Set(analysis.macroInvocations.map(call=>`${call.selectionRange.start.line}:${call.selectionRange.start.character}`));
  let visited = 0;
  function* visit(node: Parser.SyntaxNode, directive = false): Generator<AnalysisStep, void, void> {
    if (++visited % 128 === 0) { yield; }
    if (suppressed(node) || ['preproc_def','preproc_function_def','comment','string_literal'].includes(node.type)) { return; }
    const undef = preprocessorUndefinition(node);
    const token = undef ? node.childForFieldName('argument') : node;
    if (token && (undef || ['identifier','class_name'].includes(token.type))) {
      const range = undef?.range ?? nodeToAnalysisRange(token);
      if (excluded.some(item=>contains(item,range.start))) { return; }
      const candidates = (byName.get(undef?.name ?? token.text.trim()) ?? []).filter(macro=> {
        const start = macro.visibilityStart ?? (macro.uri === analysis.uri ? macro.range.end : {line:0,character:0});
        return comparePositions(start,range.start) <= 0 && !undefs.some(event=>event.startIndex < node.startIndex
          && event.name === macro.name
          && comparePositions(event.range.start,start) >= 0);
      }).sort((a,b)=>comparePositions(a.visibilityStart ?? (a.uri === analysis.uri ? a.range.end : {line:0,character:0}),
        b.visibilityStart ?? (b.uri === analysis.uri ? b.range.end : {line:0,character:0})));
      const macro = candidates.at(-1);
      const invocation = invocationStarts.has(`${range.start.line}:${range.start.character}`);
      if (macro && (macro.parameters === undefined || directive || undef || invocation)) {
        result.push({range,target:key(macro)});
      }
    }
    if (undef) { return; }
    for (const child of node.namedChildren) { yield* visit(child,directive || node.type.startsWith('preproc_')); }
  }
  yield* visit(root);
  return [...new Map(result.map(item=>[`${rangeKey(item.range)}:${item.target}`,item])).values()];
}
