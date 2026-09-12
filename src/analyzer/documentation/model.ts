import type {
  AnalysisDeclaration,
  AnalysisRange,
  AnalysisSymbolId
} from '../../types/analysis';

export interface DocSource { uri: string; range: AnalysisRange; raw: string }
export interface DocText { text: string; source: DocSource }
export interface DocParameter extends DocText {
  names: string[];
  direction?: 'in' | 'out' | 'in,out';
}
export interface DocReturnValue extends DocText { value: string }
export type SupplementKind = 'note' | 'warning' | 'deprecated' | 'todo' | 'version';
export interface DocSupplement extends DocText { kind: SupplementKind }
export interface DocTarget extends DocText {
  kind: 'fn' | 'class' | 'var' | 'def' | 'typedef';
}
export interface DocGroup extends DocText {
  kind: 'ingroup' | 'defgroup' | 'addtogroup' | '{' | '}';
}
export interface ParsedDocumentation {
  source: DocSource;
  brief: DocText[];
  details: DocText[];
  parameters: DocParameter[];
  returns: DocText[];
  returnValues: DocReturnValue[];
  supplements: DocSupplement[];
  targets: DocTarget[];
  groups: DocGroup[];
  unparsed: DocText[];
}
export interface DocumentationBlock {
  document: ParsedDocumentation;
  scopeId: string;
  adjacentDeclarationIds: AnalysisSymbolId[];
}
export interface BoundDocumentation {
  documents: ParsedDocumentation[];
  declaration: AnalysisDeclaration;
  parameterEntries: ReadonlyMap<number, readonly DocParameter[]>;
  unmatchedParameters: readonly DocParameter[];
}
export interface RenderedDocumentation { markdown: string; plainText: string }
export type DocumentationBindings = ReadonlyMap<AnalysisSymbolId, BoundDocumentation>;
