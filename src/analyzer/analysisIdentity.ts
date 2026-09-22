import type { AnalysisReference, AnalyzedDocument } from '../types/analysis';
import type { DocSource, ParsedDocumentation } from './documentation/model';

/** Rebind only URI-bearing metadata; immutable syntax, ranges and source text remain shared. */
export function rebindAnalysis(analysis: AnalyzedDocument, uri: string, version: number): AnalyzedDocument {
  if (analysis.uri === uri) { return analysis.version === version ? analysis : { ...analysis, version }; }
  const oldUri = analysis.uri;
  const source = (value: DocSource): DocSource => value.uri === oldUri ? { ...value, uri } : value;
  const documented = <T extends { source: DocSource }>(value: T): T => ({ ...value, source: source(value.source) });
  const documentation = (value: ParsedDocumentation): ParsedDocumentation => ({
    ...value, source: source(value.source), brief: value.brief.map(documented), details: value.details.map(documented),
    parameters: value.parameters.map(documented), returns: value.returns.map(documented), returnValues: value.returnValues.map(documented),
    supplements: value.supplements.map(documented), targets: value.targets.map(documented), groups: value.groups.map(documented),
    unparsed: value.unparsed.map(documented)
  });
  const located = <T extends { uri: string }>(value: T): T => value.uri === oldUri ? { ...value, uri } : value;
  const references = (values: AnalysisReference[]) => values.map(located);
  return {
    ...analysis, uri, version,
    // Symbol and scope IDs stay canonical so callers keep resolving to the same declarations.
    declarations: analysis.declarations.map(located),
    references: references(analysis.references),
    macroDefinitions: analysis.macroDefinitions.map(located), macroInvocations: analysis.macroInvocations.map(located),
    ...(analysis.typeSnapshot ? { typeSnapshot: { ...analysis.typeSnapshot, uri } } : {}),
    ...(analysis.expandedSource ? { expandedSource: { ...analysis.expandedSource,
      analysis: rebindAnalysis(analysis.expandedSource.analysis, uri, version) } } : {}),
    ...(analysis.documentationBlocks ? { documentationBlocks: analysis.documentationBlocks.map(value => ({ ...value,
      document: documentation(value.document) })) } : {}),
    ...(analysis.navigationReferences ? { navigationReferences: references(analysis.navigationReferences) } : {}),
    ...(analysis.expandedMacroReferences ? { expandedMacroReferences: references(analysis.expandedMacroReferences) } : {}),
    ...(analysis.semanticTokenReferences ? { semanticTokenReferences: references(analysis.semanticTokenReferences) } : {}),
    ...(analysis.uncertainDeclarations ? { uncertainDeclarations: analysis.uncertainDeclarations.map(located) } : {}),
    ...(analysis.uncertainMacroDefinitions ? { uncertainMacroDefinitions: analysis.uncertainMacroDefinitions.map(located) } : {})
  };
}
