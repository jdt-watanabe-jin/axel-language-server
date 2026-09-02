import type * as Parser from 'tree-sitter';
import type { AnalysisPosition, AnalysisRange } from '../types/analysis';

export function nodeToAnalysisRange(node: Parser.SyntaxNode): AnalysisRange {
  return {
    start: {
      line: node.startPosition.row,
      character: node.startPosition.column
    },
    end: {
      line: node.endPosition.row,
      character: node.endPosition.column
    }
  };
}

export function findNamedNodes(
  rootNode: Parser.SyntaxNode,
  predicate: (node: Parser.SyntaxNode) => boolean
): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (predicate(node)) {
      results.push(node);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return results;
}

export function findSmallestNamedNodeAtPosition(
  rootNode: Parser.SyntaxNode,
  position: AnalysisPosition
): Parser.SyntaxNode | null {
  if (!containsPosition(rootNode, position)) {
    return null;
  }

  for (const child of rootNode.namedChildren) {
    const found = findSmallestNamedNodeAtPosition(child, position);
    if (found !== null) {
      return found;
    }
  }

  return rootNode;
}

export function getDeclaratorName(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const named = nameFieldNode(node);
  if (named !== null) {
    return named;
  }

  const declarator = node.childForFieldName('declarator');
  if (declarator === null) {
    return null;
  }

  return findInnermostDeclaratorName(declarator);
}

function findInnermostDeclaratorName(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (isNameNode(node)) {
    return node;
  }

  const named = nameFieldNode(node);
  if (named !== null) {
    return named;
  }

  const childDeclarator = node.childForFieldName('declarator');
  if (childDeclarator !== null) {
    return findInnermostDeclaratorName(childDeclarator);
  }

  for (const child of node.namedChildren) {
    const found = findInnermostDeclaratorName(child);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

function nameFieldNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let index = node.childCount - 1; index >= 0; index -= 1) {
    const child = node.child(index);
    if (child !== null && child.isNamed && node.fieldNameForChild(index) === 'name') {
      return child;
    }
  }

  return node.childForFieldName('name');
}

function isNameNode(node: Parser.SyntaxNode): boolean {
  return [
    'identifier',
    'class_name',
    'qualified_declarator',
    'operator_declarator',
    'conversion_declarator'
  ].includes(node.type);
}

function containsPosition(node: Parser.SyntaxNode, position: AnalysisPosition): boolean {
  const range = nodeToAnalysisRange(node);
  return positionBeforeOrEqual(range.start, position) && positionBefore(position, range.end);
}

function positionBeforeOrEqual(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character <= right.character);
}

function positionBefore(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}
