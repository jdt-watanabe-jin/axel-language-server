import type { AnalysisDeclaration, AnalysisPosition, AnalysisRange, AnalyzedDocument } from '../types/analysis';
import { runAnalysisSteps, type AnalysisStep } from '../util/analysisSteps';
import { callTargetDeclarations, findNavigationTargetDeclaration, type WorkspaceNavigationIndex } from './navigation';
import { acceptedArgumentCounts, comparePositions, contains } from './resolution';
import { field } from './typeChecking/syntax';

export interface AnalysisInlayHint { position: AnalysisPosition; label: string; resolveTarget?: { declaration: AnalysisDeclaration; parameter: number } }
export interface InlayHintsInput {
  includeResolveMetadata?: boolean;
  analysis: AnalyzedDocument;
  text: string;
  range: AnalysisRange;
  workspaceIndex: WorkspaceNavigationIndex;
  suppressWhenArgumentContainsName: boolean;
}

export function getInlayHints(input: InlayHintsInput): AnalysisInlayHint[] {
  return runAnalysisSteps(getInlayHintsSteps(input));
}

/** Reuse immutable syntax and cached call resolution; never parse once per argument. */
export function* getInlayHintsSteps(input: InlayHintsInput): Generator<AnalysisStep, AnalysisInlayHint[], void> {
  yield;
  const {analysis,text,range} = input;
  const semantic = analysis.expandedSource?.analysis ?? analysis;
  const root = semantic.typeSnapshot?.root;
  if (!root) { return []; }
  const excluded = [...analysis.inactiveRanges ?? [],...analysis.uncertainRanges ?? []];
  const mapped = (value: AnalysisRange): AnalysisRange | undefined =>
    analysis.expandedSource ? analysis.expandedSource.highlightRange?.(value) : value;
  const sourceRange = (value: AnalysisRange): AnalysisRange =>
    analysis.expandedSource?.sourceRange(value) ?? value;
  const starts = [0];
  for (let i = 0; i < text.length; i++) { if (text[i] === '\n') { starts.push(i+1); } }
  const offset = (position: AnalysisPosition) => (starts[position.line] ?? text.length) + position.character;
  const hints = new Map<string,AnalysisInlayHint>();
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    if (++visited % 64 === 0) { yield; }
    const node = pending.pop()!;
    const location = sourceRange(node.range);
    if (comparePositions(location.end,range.start) < 0 || comparePositions(location.start,range.end) > 0
      || node.kind === 'ERROR') { continue; }
    for (let i = node.children.length-1; i >= 0; i--) { pending.push(node.children[i]); }
    if (node.kind !== 'call_expression' || excluded.some(item=>contains(item,location.start))) { continue; }
    const callee = field(node,'function');
    const target = callee && (field(callee,'field') ?? (callee.kind === 'qualified_identifier' ? field(callee,'name') ?? callee.children.at(-1) : callee));
    const targetRange = target && mapped(target.range);
    const args = field(node,'arguments');
    if (!targetRange || !args?.argumentDelimiters?.length) { continue; }
    const children = args.children.filter(child=>child.kind !== 'comment');
    const trailingComma = children.at(-1)?.kind === 'ERROR' && children.at(-1)?.text === ',';
    const values = trailingComma ? children.slice(0,-1) : children;
    if (values.some(child=>child.kind === 'ERROR' || child.missing)) { continue; }
    const delimiters = args.argumentDelimiters;
    const slots = delimiters.slice(0,-1).map((left,i)=>({
      start:left.range.end,end:delimiters[i+1].range.start
    }));
    // An editor may omit the closing parenthesis. The parsed list end bounds its last slot.
    if (delimiters.at(-1)?.text !== ')') {
      slots.push({start:delimiters.at(-1)!.range.end,end:args.range.end});
    }
    if (values.some(value=>!slots.some(slot=>contains(slot,value.range.start)))) { continue; }
    // Empty interior slots have no trustworthy positional correspondence.
    if (slots.slice(0,-1).some(slot=>!values.some(value=>contains(slot,value.range.start)))) { continue; }
    const navigation = {analysis,position:targetRange.start,workspaceIndex:input.workspaceIndex};
    const partial = trailingComma || delimiters.at(-1)?.text !== ')' || !!delimiters.at(-1)?.missing;
    const resolved = callTargetDeclarations(navigation,partial);
    const fallback = resolved === undefined ? findNavigationTargetDeclaration(navigation) : undefined;
    const candidates = (resolved ?? (fallback ? [fallback] : [])).filter(candidate => {
      const counts = acceptedArgumentCounts(candidate);
      return values.length <= counts.max && (partial || values.length >= counts.min);
    });
    if (!candidates.length) { continue; }
    const exactOrigins = values.map(value=>mapped(value.range));
    const argumentRange = (value: AnalysisRange) => mapped(value) ?? analysis.expandedSource?.referenceRange?.(value) ?? sourceRange(value);
    const origins = values.map((value,i)=>exactOrigins[i] ?? argumentRange(value.range));
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      const valueRange = origins[i];
      if (!contains(range,valueRange.start) || origins.some((other,j)=>j !== i && (!exactOrigins[i] || exactOrigins[j])
        && comparePositions(other.start,valueRange.end) < 0 && comparePositions(valueRange.start,other.end) < 0)) { continue; }
      const parameters = candidates.map(candidate=>candidate.signature?.parameters[i]);
      const name = parameters[0]?.name;
      if (!name || parameters.some(parameter=>parameter?.variadic || parameter?.name !== name)) { continue; }
      const slot = slots.find(slot=>contains(slot,value.range.start));
      if (!slot) { continue; }
      const span = argumentRange(slot);
      const argumentText = text.slice(offset(span.start),offset(span.end));
      if (input.suppressWhenArgumentContainsName && argumentText.toLowerCase().includes(name.toLowerCase())) { continue; }
      const hint: AnalysisInlayHint = {position:valueRange.start,label:name + ':'};
      if (input.includeResolveMetadata && candidates.length === 1) {
        hint.resolveTarget = { declaration: candidates[0], parameter: i };
      }
      hints.set(JSON.stringify([hint.position, hint.label]),hint);
    }
  }
  return [...hints.values()].sort((a,b)=>comparePositions(a.position,b.position) || a.label.localeCompare(b.label));
}
