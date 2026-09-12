import type { AnalysisDeclaration, AnalyzedDocument } from '../../types/analysis';
import { bindDocumentation } from './index';
import type { BoundDocumentation, DocumentationBindings, RenderedDocumentation } from './model';
import { renderDocumentation } from './render';

export interface DocumentationLookup {
  documentationBindings?(sourceUri: string): DocumentationBindings;
  listVisibleDocuments?(sourceUri: string): AnalyzedDocument[];
  listVisibleDeclarations?(sourceUri: string): AnalysisDeclaration[];
}
const localBindings = new WeakMap<AnalyzedDocument, DocumentationBindings>();
export function documentationBindingsFor(analysis: AnalyzedDocument, lookup: DocumentationLookup): DocumentationBindings {
  if (lookup.documentationBindings) { return lookup.documentationBindings(analysis.uri); }
  const documents = lookup.listVisibleDocuments?.(analysis.uri) ?? [];
  if (!documents.some(d => d.uri !== analysis.uri)) {
    let bound = localBindings.get(analysis);
    if (!bound) { bound = bindDocumentation(analysis, [analysis], analysis.declarations); localBindings.set(analysis, bound); }
    return bound;
  }
  const visible = lookup.listVisibleDeclarations?.(analysis.uri) ?? [...analysis.declarations, ...documents.flatMap(d => d.declarations)];
  return bindDocumentation(analysis, documents, visible);
}
export function boundDocumentationFor(analysis: AnalyzedDocument, lookup: DocumentationLookup, declaration: AnalysisDeclaration): BoundDocumentation | undefined {
  return documentationBindingsFor(analysis, lookup).get(declaration.id);
}
export function renderedDocumentationFor(analysis: AnalyzedDocument, lookup: DocumentationLookup,
  declaration: AnalysisDeclaration, locale?: string): RenderedDocumentation | undefined {
  const bound = boundDocumentationFor(analysis, lookup, declaration);
  return bound ? renderDocumentation(bound, locale) : undefined;
}
