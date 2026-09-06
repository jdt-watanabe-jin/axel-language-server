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
