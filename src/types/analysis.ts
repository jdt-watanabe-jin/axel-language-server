export interface AnalysisPosition {
  line: number;
  character: number;
}

export interface AnalysisRange {
  start: AnalysisPosition;
  end: AnalysisPosition;
}

export type AnalysisDocumentUri = string;

export type AnalysisSymbolId = string;

export type AnalysisSymbolRole = 'declaration' | 'definition' | 'reference';

export type AnalysisDiagnosticSeverity = 'error' | 'warning';

export interface AnalysisDiagnostic {
  severity: AnalysisDiagnosticSeverity;
  source: 'axel';
  message: string;
  range: AnalysisRange;
}

export type AnalysisSymbolKind =
  | 'operator'
  | 'function'
  | 'method'
  | 'parameter'
  | 'field'
  | 'variable'
  | 'typedef'
  | 'class'
  | 'struct'
  | 'union'
  | 'enum'
  | 'enumMember'
  | 'macro'
  | 'include';

export interface AnalysisSymbol {
  name: string;
  kind: AnalysisSymbolKind;
  detail?: string;
  range: AnalysisRange;
  selectionRange: AnalysisRange;
  children?: AnalysisSymbol[];
}

export type AnalysisDeclarationKind = Exclude<AnalysisSymbolKind, 'operator'>;

export interface AnalysisDeclaration {
  id: AnalysisSymbolId;
  name: string;
  kind: AnalysisDeclarationKind;
  uri: AnalysisDocumentUri;
  range: AnalysisRange;
  selectionRange: AnalysisRange;
  detail: string;
  containerName?: string;
  typeName?: string;
  baseName?: string;
  signature?: AnalysisSignature;
}

export interface AnalysisParameter {
  label: string;
}

export interface AnalysisSignature {
  label: string;
  parameters: AnalysisParameter[];
}

export interface AnalysisSignatureHelp {
  signatures: AnalysisSignature[];
  activeSignature: number;
  activeParameter: number;
}

export interface AnalysisFormattingOptions {
  insertSpaces: boolean;
  tabSize: number;
}

export interface AnalysisTextEdit {
  range: AnalysisRange;
  newText: string;
}

export interface AnalysisWorkspaceEdit {
  changes: Record<AnalysisDocumentUri, AnalysisTextEdit[]>;
}

export interface AnalysisCodeAction {
  title: string;
  kind: 'quickfix';
  diagnostics: AnalysisDiagnostic[];
  edit: AnalysisWorkspaceEdit;
}

export interface AnalysisMemberAccess {
  receiverName: string;
  memberNames: string[];
}

export interface AnalysisReference {
  name: string;
  uri: AnalysisDocumentUri;
  range: AnalysisRange;
  targetId?: AnalysisSymbolId;
  call?: boolean;
  typeReference?: boolean;
  memberAccess?: AnalysisMemberAccess;
}

export interface AnalysisHover {
  markdown: string;
  plainText: string;
}

export type AnalysisCompletionItemKind =
  | 'keyword'
  | 'function'
  | 'variable'
  | 'class'
  | 'struct'
  | 'union'
  | 'enum'
  | 'enumMember'
  | 'macro'
  | 'typedef'
  | 'include'
  | 'property'
  | 'method'
  | 'event';

export interface AnalysisCompletionItem {
  name: string;
  kind: AnalysisCompletionItemKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  filterText?: string;
  sortText?: string;
}

export type AnalysisSemanticTokenType =
  | 'class'
  | 'enum'
  | 'enumMember'
  | 'function'
  | 'macro'
  | 'method'
  | 'operator'
  | 'parameter'
  | 'property'
  | 'struct'
  | 'type'
  | 'variable';

export type AnalysisSemanticTokenModifier = 'declaration';

export interface AnalysisSemanticToken {
  range: AnalysisRange;
  tokenType: AnalysisSemanticTokenType;
  modifiers: AnalysisSemanticTokenModifier[];
}

export interface AnalysisScope {
  id: AnalysisSymbolId;
  parentId?: AnalysisSymbolId;
  range: AnalysisRange;
  declarationIds: AnalysisSymbolId[];
}

export type AnalysisGuiClassKind = 'dialog' | 'fileDialog' | 'widget' | 'guiPart';

export interface AnalysisGuiMethod {
  name: string;
  receiverPath: string[];
  receiverPathSegmentRanges?: AnalysisRange[];
  selectionRange?: AnalysisRange;
  event: boolean;
  range: AnalysisRange;
}

export interface AnalysisGuiPart {
  name?: string;
  typeName: string;
  path: string[];
  anonymous: boolean;
  range: AnalysisRange;
  selectionRange?: AnalysisRange;
  parts: AnalysisGuiPart[];
  methods: AnalysisGuiMethod[];
}

export interface AnalysisGuiClass {
  name: string;
  baseName: string;
  kind: AnalysisGuiClassKind;
  range: AnalysisRange;
  parts: AnalysisGuiPart[];
  methods: AnalysisGuiMethod[];
}

export interface AnalysisKnownGuiClass {
  name: string;
  kind: AnalysisGuiClassKind;
}

export interface AnalysisPreprocessorSymbol {
  name: string;
  value?: string;
}

export type AnalysisIncludeKind = 'quote' | 'angle' | 'bare' | 'expression';

export interface AnalysisInclude {
  includePath: string;
  kind: AnalysisIncludeKind;
  range: AnalysisRange;
}

export interface AnalysisResolvedInclude {
  includePath: string;
  filePath: string;
  uri: AnalysisDocumentUri;
  range: AnalysisRange;
}

export interface AnalysisScriptExecution {
  scriptPath: string;
  range: AnalysisRange;
  selectionRange: AnalysisRange;
}

export interface AnalysisResolvedScriptExecution {
  scriptPath: string;
  filePath: string;
  uri: AnalysisDocumentUri;
  range: AnalysisRange;
}

export interface AnalyzeDocumentInput {
  uri: string;
  version: number;
  text: string;
  knownGuiClasses?: readonly AnalysisKnownGuiClass[];
  knownGuiClassNames?: readonly string[];
  preprocessorSymbols?: readonly AnalysisPreprocessorSymbol[];
}

export interface AnalyzedDocument {
  uri: string;
  version: number;
  diagnostics: AnalysisDiagnostic[];
  symbols: AnalysisSymbol[];
  declarations: AnalysisDeclaration[];
  references: AnalysisReference[];
  semanticTokenReferences?: AnalysisReference[];
  semanticTokens?: AnalysisSemanticToken[];
  scopes: AnalysisScope[];
  includes: AnalysisInclude[];
  scriptExecutions: AnalysisScriptExecution[];
  guiClasses: AnalysisGuiClass[];
  guiMethods: AnalysisGuiMethod[];
  inactiveRanges?: AnalysisRange[];
}
