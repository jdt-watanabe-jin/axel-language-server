import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  AnalysisCodeAction,
  AnalysisDeclaration,
  AnalysisDiagnostic,
  AnalysisRange,
  AnalysisWorkspaceEdit,
  AnalyzedDocument
} from '../types/analysis';
import { isTypeDeclaration } from './resolution';

export interface CodeActionInput {
  analysis: Pick<AnalyzedDocument, 'uri'>;
  range: AnalysisRange;
  diagnostics: AnalysisDiagnostic[];
  workspaceIndex: WorkspaceCodeActionIndex;
}

export interface WorkspaceCodeActionIndex {
  findDeclarations?(name: string): AnalysisDeclaration[];
}

export function getCodeActions(input: CodeActionInput): AnalysisCodeAction[] {
  return input.diagnostics
    .filter((diagnostic) => rangesIntersect(diagnostic.range, input.range))
    .flatMap((diagnostic) => includeQuickFix(input, diagnostic));
}

function includeQuickFix(input: CodeActionInput, diagnostic: AnalysisDiagnostic): AnalysisCodeAction[] {
  const missingTypeName = missingTypeNameFromDiagnostic(diagnostic);
  if (missingTypeName === undefined) {
    return [];
  }

  const candidates = (input.workspaceIndex.findDeclarations?.(missingTypeName) ?? [])
    .filter(isTypeDeclaration)
    .filter((declaration) => declaration.uri !== input.analysis.uri);
  if (candidates.length !== 1) {
    return [];
  }

  const includePath = relativeIncludePath(input.analysis.uri, candidates[0].uri);
  if (includePath === undefined) {
    return [];
  }

  return [{
    title: `Add include "${includePath}"`,
    kind: 'quickfix',
    diagnostics: [diagnostic],
    edit: includeWorkspaceEdit(input.analysis.uri, includePath)
  }];
}

function missingTypeNameFromDiagnostic(diagnostic: AnalysisDiagnostic): string | undefined {
  const match = /^Unknown type '([^']+)'\.$/.exec(diagnostic.message);
  return match?.[1];
}

function includeWorkspaceEdit(sourceUri: string, includePath: string): AnalysisWorkspaceEdit {
  return {
    changes: {
      [sourceUri]: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 }
        },
        newText: `#include "${includePath}"\n`
      }]
    }
  };
}

function relativeIncludePath(sourceUri: string, targetUri: string): string | undefined {
  const sourcePath = filePathFromUri(sourceUri);
  const targetPath = filePathFromUri(targetUri);
  if (sourcePath === undefined || targetPath === undefined) {
    return undefined;
  }

  return path.relative(path.dirname(sourcePath), targetPath).replace(/\\/g, '/');
}

function filePathFromUri(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function rangesIntersect(left: AnalysisRange, right: AnalysisRange): boolean {
  return positionBefore(left.start, right.end) && positionBefore(right.start, left.end);
}

function positionBefore(
  left: AnalysisRange['start'],
  right: AnalysisRange['start']
): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}
