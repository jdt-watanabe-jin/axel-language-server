import type * as Parser from 'tree-sitter';
import type { AnalysisIncludeKind, AnalysisRange } from '../types/analysis';
import type { AnalysisStep } from '../util/analysisSteps';
import { collectIncludes, scriptExecutionFromNode } from './includeResolver';

export interface DocumentLinkCandidate {
  kind: 'include' | 'script';
  path: string;
  includeKind?: AnalysisIncludeKind;
  range: AnalysisRange;
}

/** Literal paths from original syntax, including inactive branches. Never expand or execute code. */
export function* collectDocumentLinksSteps(root: Parser.SyntaxNode): Generator<AnalysisStep, DocumentLinkCandidate[], void> {
  const result: DocumentLinkCandidate[] = [];
  // Native tree lookup avoids materializing every expression node in large files.
  const nodes = root.descendantsOfType(['preproc_include', 'command_statement']);
  yield;
  for (let index = 0; index < nodes.length; index++) {
    if (index % 128 === 0) { yield; }
    const node = nodes[index];
    if (node.type === 'preproc_include') {
      for (const include of collectIncludes(node)) {
        if ((include.kind !== 'quote' && include.kind !== 'angle') || !include.includePath) { continue; }
        const pathNode = node.childForFieldName('path');
        const prefixLength = pathNode?.text.startsWith('L"') ? 2 : 1;
        const range = { start: { ...include.range.start, character: include.range.start.character + prefixLength },
          end: { ...include.range.end, character: include.range.end.character - 1 } };
        if (range.start.line === range.end.line && range.start.character < range.end.character) {
          result.push({ kind: 'include', path: include.includePath, includeKind: include.kind, range });
        }
      }
      continue;
    }
    if (node.type === 'command_statement') {
      const script = scriptExecutionFromNode(node);
      if (script) {
        result.push({ kind: 'script', path: script.scriptPath, range: script.selectionRange });
      }
      continue;
    }
  }
  return result;
}
