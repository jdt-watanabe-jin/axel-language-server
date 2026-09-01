import { MarkupKind, type Hover } from 'vscode-languageserver/node';
import type { AnalysisHover } from '../types/analysis';

export function toLspHover(hover: AnalysisHover): Hover {
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: hover.markdown
    }
  };
}
