import type { AnalyzedDocument } from '../../types/analysis';

// Complete neutral analysis for boundary failure/routing tests. No mutable singleton.
export function emptyAnalysis(overrides: Partial<AnalyzedDocument> = {}): AnalyzedDocument {
  return {
    uri: 'file:///main.axl', version: 1, diagnostics: [], symbols: [], declarations: [],
    references: [], macroDefinitions: [], macroInvocations: [], scopes: [], includes: [],
    scriptExecutions: [], guiClasses: [], guiMethods: [], ...overrides
  };
}
export interface TestDocument {
  uri: string;
  version: number;
  getText(): string;
}

export function createTestDocument(text: string): TestDocument {
  return {
    uri: 'file:///main.axl',
    version: 1,
    getText: () => text
  };
}

// Neutral registrations shared by request boundary fixtures; overrides capture the request under test.
export function createHandlerConnection(overrides: Record<string, unknown> = {}) {
  return {
    onInitialize: () => undefined,
    onDidChangeWatchedFiles: () => undefined,
    languages: { diagnostics: { on: () => undefined }, semanticTokens: { on: () => undefined } },
    onHover: () => undefined, onCompletion: () => undefined, onDefinition: () => undefined,
    onReferences: () => undefined, onPrepareRename: () => undefined, onRenameRequest: () => undefined,
    onCodeAction: () => undefined, onSignatureHelp: () => undefined, onDocumentSymbol: () => undefined,
    console: { error: () => undefined }, ...overrides
  };
}
