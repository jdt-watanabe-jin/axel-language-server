import type { TextEdit } from 'vscode-languageserver/node';
import type { AnalysisTextEdit } from '../types/analysis';

export function toLspTextEdits(edits: AnalysisTextEdit[]): TextEdit[] {
  return edits.map((edit) => ({
    range: edit.range,
    newText: edit.newText
  }));
}
