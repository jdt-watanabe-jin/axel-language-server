import { CodeActionKind, type CodeAction } from 'vscode-languageserver/node';
import type { AnalysisCodeAction } from '../types/analysis';
import { toLspDiagnostic } from './diagnostics';
import { toLspWorkspaceEdit } from './rename';

export function toLspCodeActions(actions: AnalysisCodeAction[]): CodeAction[] {
  return actions.map((action) => ({
    title: action.title,
    kind: CodeActionKind.QuickFix,
    diagnostics: action.diagnostics.map(toLspDiagnostic),
    edit: toLspWorkspaceEdit(action.edit)
  }));
}
