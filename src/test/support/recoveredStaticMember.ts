import type { AnalysisDeclaration, AnalyzedDocument } from '../../types/analysis';

// Reproduces a recovered header whose method lost its container metadata.
export function recoveredStaticMemberFixture(): {
  analysis: AnalyzedDocument;
  workspaceIndex: {
    findVisibleDeclarations(sourceUri: string, name: string): AnalysisDeclaration[];
    listVisibleDeclarations(sourceUri: string): AnalysisDeclaration[];
  };
} {
  const mainUri = 'file:///main.axl';
  const headerUri = 'file:///file.h';
  const declarations: AnalysisDeclaration[] = [
    {
      id: `${headerUri}#0:6:FILE`,
      name: 'FILE',
      kind: 'class',
      uri: headerUri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      detail: 'class'
    },
    {
      id: `${headerUri}#5:13:IsDirectory`,
      name: 'IsDirectory',
      kind: 'function',
      uri: headerUri,
      range: { start: { line: 5, character: 2 }, end: { line: 5, character: 38 } },
      selectionRange: { start: { line: 5, character: 13 }, end: { line: 5, character: 24 } },
      detail: 'static int IsDirectory(string fname)'
    }
  ];

  return {
    analysis: {
      uri: mainUri,
      version: 1,
      diagnostics: [],
      symbols: [],
      declarations: [],
      references: [{
        name: 'IsDirectory',
        uri: mainUri,
        range: { start: { line: 0, character: 20 }, end: { line: 0, character: 31 } },
        call: true,
        memberAccess: {
          receiverName: 'FILE',
          memberNames: ['IsDirectory']
        }
      }],
      macroDefinitions: [],
      macroInvocations: [],
      scopes: [],
      includes: [],
      scriptExecutions: [],
      guiClasses: [],
      guiMethods: []
    },
    workspaceIndex: {
      findVisibleDeclarations(_sourceUri: string, name: string): AnalysisDeclaration[] {
        return declarations.filter((declaration) => declaration.name === name);
      },
      listVisibleDeclarations(): AnalysisDeclaration[] {
        return declarations;
      }
    }
  };
}
