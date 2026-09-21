import type { AnalyzedDocument, AnalysisRange } from '../types/analysis';
import { collectOverrides, declarationsForFunction } from './callHierarchySemantics';
import { createTypeTargetContext, typeTargetInput, type TypeTargetWorkspace } from './typeTarget';
import { contains } from './resolution';

export interface CodeLensCandidate { kind: 'references' | 'implementations'; range: AnalysisRange }

/** Enumerate source declarations only; reference/project searches run when a lens is resolved. */
export function getCodeLensCandidates(analysis: AnalyzedDocument, workspace: TypeTargetWorkspace): CodeLensCandidate[] {
  const excluded = [...analysis.inactiveRanges ?? [], ...analysis.uncertainRanges ?? [],
    ...analysis.completionExcludedRanges ?? [], ...analysis.syntaxRecovery?.ranges ?? []];
  const declarations = analysis.declarations.filter(declaration => declaration.uri === analysis.uri
    && (declaration.kind === 'function' || declaration.kind === 'method')
    && !excluded.some(range => contains(range, declaration.selectionRange.start)));
  const virtual = new Set<string>();
  if (declarations.length) {
    const context = createTypeTargetContext(typeTargetInput(analysis, workspace));
    if (context) {
      for (const fn of context.types.functions) {
        if (fn.uri === analysis.uri && fn.owner && fn.virtual) {
          for (const declaration of declarationsForFunction(context.input, context.types, fn)) { virtual.add(declaration.id); }
        }
      }
      for (const edge of collectOverrides(context.input, context.types)) {
        virtual.add(edge.base.id); virtual.add(edge.derived.id);
      }
    }
  }
  const result: CodeLensCandidate[] = [];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const key = JSON.stringify(declaration.selectionRange);
    if (seen.has(key)) { continue; }
    seen.add(key);
    result.push({kind:'references',range:declaration.selectionRange});
    if (virtual.has(declaration.id)) { result.push({kind:'implementations',range:declaration.selectionRange}); }
  }
  return result;
}
