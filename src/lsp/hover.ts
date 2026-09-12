import { MarkupKind, type Hover } from 'vscode-languageserver/node';
import type { AnalysisHover } from '../types/analysis';

export function toLspHover(hover: AnalysisHover, markdown = true): Hover {
  return {
    contents: {
      kind: markdown ? MarkupKind.Markdown : MarkupKind.PlainText,
      value: markdown ? hover.markdown : hover.plainText
    }
  };
}
