import type { AnalysisDeclaration, AnalysisReference, AnalyzedDocument } from '../../types/analysis';

export function createVisibleEnumMemberDeclarations(memberCount: number): AnalysisDeclaration[] {
  const declarations: AnalysisDeclaration[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    declarations.push({
      id: `file:///messages.hh#${index}:2:MD_MESSAGE_${index}`,
      name: `MD_MESSAGE_${index}`,
      kind: 'enumMember',
      uri: 'file:///messages.hh',
      range: {
        start: { line: index, character: 0 },
        end: { line: index, character: 24 }
      },
      selectionRange: {
        start: { line: index, character: 2 },
        end: { line: index, character: 14 }
      },
      detail: `enum MessageId::MD_MESSAGE_${index}`,
      containerName: 'MessageId'
    });
  }
  return declarations;
}

export function createReferenceHeavyAnalysis(referenceCount: number): AnalyzedDocument {
  const references: AnalysisReference[] = [];
  for (let index = 0; index < referenceCount; index += 1) {
    references.push({
      name: `MD_MESSAGE_${index}`,
      uri: 'file:///main.axl',
      range: {
        start: { line: index, character: 10 },
        end: { line: index, character: 22 }
      }
    });
  }

  return {
    uri: 'file:///main.axl',
    version: 1,
    diagnostics: [],
    symbols: [],
    declarations: [],
    references,
    macroDefinitions: [],
    macroInvocations: [],
    semanticTokenReferences: [],
    semanticTokens: [],
    scopes: [{
      id: 'global',
      range: {
        start: { line: 0, character: 0 },
        end: { line: referenceCount, character: 0 }
      },
      declarationIds: []
    }],
    includes: [],
    scriptExecutions: [],
    guiClasses: [],
    guiMethods: [],
    inactiveRanges: []
  };
}

export function createGuiReferenceHeavyAnalysis(referenceCount: number): AnalyzedDocument {
  const references: AnalysisReference[] = [];
  for (let index = 0; index < referenceCount; index += 1) {
    references.push({
      name: `unknown_${index}`,
      uri: 'file:///main.axl',
      range: {
        start: { line: index + 1, character: 2 },
        end: { line: index + 1, character: 11 }
      }
    });
  }

  const classRange = {
    start: { line: 0, character: 0 },
    end: { line: referenceCount + 100, character: 0 }
  };
  const methodRange = {
    start: { line: 1, character: 0 },
    end: { line: referenceCount + 50, character: 0 }
  };

  return {
    uri: 'file:///main.axl',
    version: 1,
    diagnostics: [],
    symbols: [],
    declarations: [{
      id: 'file:///main.axl#0:6:Dialog',
      name: 'Dialog',
      kind: 'class',
      uri: 'file:///main.axl',
      range: classRange,
      selectionRange: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 12 }
      },
      detail: 'class',
      baseName: 'GCDialog'
    }],
    references,
    macroDefinitions: [],
    macroInvocations: [],
    semanticTokenReferences: [],
    semanticTokens: [],
    scopes: [{
      id: 'global',
      range: classRange,
      declarationIds: ['file:///main.axl#0:6:Dialog']
    }],
    includes: [],
    scriptExecutions: [],
    guiClasses: [{
      name: 'Dialog',
      baseName: 'GCDialog',
      kind: 'dialog',
      range: classRange,
      parts: [],
      methods: [{
        name: 'OnCreate',
        receiverPath: ['Dialog', 'OnCreate'],
        selectionRange: {
          start: { line: 0, character: 14 },
          end: { line: 0, character: 22 }
        },
        event: true,
        range: methodRange
      }]
    }],
    guiMethods: [],
    inactiveRanges: []
  };
}

