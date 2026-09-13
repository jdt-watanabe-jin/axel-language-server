import { mapSourceOffset } from './sourceOffsetMap';
import type * as Parser from 'tree-sitter';
import type { AnalysisPosition, AnalysisRange, AnalyzedDocument } from '../types/analysis';
import { createMacroLookup } from './diagnostics';
import { collectMacroSourceReplacements } from './macroExpansion';
import { comparePositions, contains } from './resolution';
import { nodeToAnalysisRange } from './syntaxTree';

function positions(text: string) {
  const starts = [0];
  for (let i=0; i<text.length; i++) { if (text[i] === '\n') { starts.push(i+1); } }
  return {
    offset: (p: AnalysisPosition): number => (starts[p.line] ?? text.length) + p.character,
    position: (offset: number): AnalysisPosition => {
      let low=0, high=starts.length;
      while (low+1<high) { const mid=(low+high)>>>1; if (starts[mid]<=offset) { low=mid; } else { high=mid; } }
      return {line:low,character:offset-starts[low]};
    }
  };
}

/** Reparse a virtual source and map all analysis locations back to the user's document. */
export function macroReparse(root: Parser.SyntaxNode, source: string, original: AnalyzedDocument,
  macros: AnalyzedDocument['macroDefinitions'], analyze: (text: string, position: (p: AnalysisPosition, end?: boolean) => AnalysisPosition) => AnalyzedDocument): AnalyzedDocument {
  if (!macros.length) { return original; }
  const sourcePositions = positions(source);
  const excluded = [...original.inactiveRanges ?? [], ...original.uncertainRanges ?? []];
  const undefs = root.descendantsOfType('preproc_call').filter(n => n.childForFieldName('directive')?.text.trim() === '#undef'
    && !excluded.some(r => contains(r,nodeToAnalysisRange(n).start)));
  const replacements = collectMacroSourceReplacements(source, offset => {
    const position = sourcePositions.position(offset);
    if (excluded.some(r => contains(r,position))) { return undefined; }
    const visible = createMacroLookup(macros,original.uri,position);
    return {findMacro: name => {
      // NULL provenance and runtime system macros are resolved by the type-checking context.
      if (name === 'NULL' || original.uncertainNames?.includes(name)) { return undefined; }
      const macro = visible.findMacro(name);
      if (!macro) { return undefined; }
      const origin = macro.visibilityStart ?? (macro.uri === original.uri ? macro.range.end : {line:0,character:0});
      return undefs.some(n => n.childForFieldName('argument')?.text.trim() === name && n.startIndex < offset
        && comparePositions(nodeToAnalysisRange(n).start,origin)>=0) ? undefined : macro;
    }};
  });
  if (!replacements.length) { return original; }
  let text='', cursor=0;
  const segments = replacements.map(replacement => {
    text += source.slice(cursor,replacement.start);
    const start=text.length;
    text += replacement.text;
    cursor=replacement.end;
    return {...replacement, expandedStart:start, expandedEnd:text.length};
  });
  text += source.slice(cursor);
  const expandedPositions = positions(text);
  const toOriginalSegments = segments.map(s=>({start:s.expandedStart,end:s.expandedEnd,targetStart:s.start,targetEnd:s.end}));
  const toExpandedSegments = segments.map(s=>({start:s.start,end:s.end,targetStart:s.expandedStart,targetEnd:s.expandedEnd}));
  const offset = (index:number,end:boolean) => mapSourceOffset(toOriginalSegments,index,end);
  const point = (p: AnalysisPosition, end=false): AnalysisPosition => sourcePositions.position(offset(expandedPositions.offset(p),end));
  const mappedRange = (r: AnalysisRange): AnalysisRange => ({start:point(r.start),end:point(r.end,true)});
  const mappedObjects = new WeakMap<object, unknown>();
  function map(value: unknown): unknown {
    if (value && typeof value === 'object' && mappedObjects.has(value)) { return mappedObjects.get(value); }
    if (Array.isArray(value)) { const mapped: unknown[] = []; mappedObjects.set(value, mapped); mapped.push(...value.map(map)); return mapped; }
    if (!value || typeof value !== 'object') { return value; }
    const record = value as Record<string, unknown>;
    if (typeof record.uri === 'string' && record.uri !== original.uri) { return value; }
    if ('line' in record && 'character' in record) { return point(value as AnalysisPosition); }
    if (typeof record.start === 'object' && typeof record.end === 'object') { return mappedRange(value as AnalysisRange); }
    const mapped: Record<string, unknown> = {};
    mappedObjects.set(value, mapped);
    for (const [key,item] of Object.entries(record)) { mapped[key] = map(item); }
    if ('kind' in record && typeof record.start === 'number' && typeof record.end === 'number') {
      mapped.start=offset(record.start,false); mapped.end=offset(record.end,true);
    }
    return mapped;
  }
  const toExpanded = (p: AnalysisPosition, end=false): AnalysisPosition => {
    const index=sourcePositions.offset(p);
    return expandedPositions.position(mapSourceOffset(toExpandedSegments,index,end));
  };
  const result = map(analyze(text,toExpanded)) as AnalyzedDocument;
  // Conditional recovery may have erased directives before this second parse.
  const writtenIncludes = new Map(original.includes.map(include =>
    [`${include.range.start.line}:${include.range.start.character}`, include]));
  result.includes = result.includes.map(include => {
    const written = writtenIncludes.get(`${include.range.start.line}:${include.range.start.character}`);
    return written?.conditional || !written ? {...include, conditional: true} : include;
  });
  // Macro hover/navigation use the written invocation, not tokens introduced by its body.
  result.macroInvocations = original.macroInvocations;
  result.systemMacroReferences = original.systemMacroReferences;
  result.scriptExecutions = result.scriptExecutions.filter(script => /\.axl$/i.test(script.scriptPath)
    || !replacements.some(r => sourcePositions.offset(script.selectionRange.start) >= r.start
      && sourcePositions.offset(script.selectionRange.end) <= r.end));
  result.macroDefinitions = original.macroDefinitions;
  result.expandedMacroReferences = replacements.map(r=>({name:r.name,uri:original.uri,
    range:{start:sourcePositions.position(r.start),end:sourcePositions.position(r.start+r.name.length)}}));
  const containingReplacement = (range: AnalysisRange) => {
    const start=sourcePositions.offset(range.start), end=sourcePositions.offset(range.end);
    let low=0, high=replacements.length;
    while(low<high) {
      const mid=(low+high)>>>1;
      if(replacements[mid].start<=start) { low=mid+1; } else { high=mid; }
    }
    const replacement=replacements[low-1];
    return replacement && end<=replacement.end ? replacement : undefined;
  };
  const inExpansion = (range: AnalysisRange): boolean => containingReplacement(range)!==undefined;
  const argumentsInSource = original.references.filter(ref => {
    const replacement=containingReplacement(ref.range);
    return replacement!==undefined && sourcePositions.offset(ref.range.start)>=replacement.start+replacement.name.length;
  });
  result.navigationReferences = [...result.expandedMacroReferences, ...argumentsInSource,
    ...result.references.filter(ref=>!inExpansion(ref.range))];
  result.references.unshift(...result.expandedMacroReferences);
  return result;
}
