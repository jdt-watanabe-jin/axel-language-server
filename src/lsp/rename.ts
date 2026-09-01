import type { WorkspaceEdit } from 'vscode-languageserver/node';
import type { AnalysisWorkspaceEdit } from '../types/analysis';

export function toLspWorkspaceEdit(edit: AnalysisWorkspaceEdit): WorkspaceEdit {
  return {
    changes: edit.changes
  };
}
