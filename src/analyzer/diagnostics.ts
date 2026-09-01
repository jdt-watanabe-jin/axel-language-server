import type * as Parser from 'tree-sitter';
import type { AnalysisDiagnostic } from '../types/analysis';
import { findNamedNodes, nodeToAnalysisRange } from './syntaxTree';

export function collectSyntaxDiagnostics(rootNode: Parser.SyntaxNode): AnalysisDiagnostic[] {
  const errorNodes = findNamedNodes(
    rootNode,
    (node) => node.type === 'ERROR' || node.isMissing
  );

  return errorNodes.map((node) => ({
    severity: 'error',
    source: 'axel',
    message: node.isMissing ? `Missing ${node.type}.` : 'Syntax error.',
    range: nodeToAnalysisRange(node)
  }));
}
