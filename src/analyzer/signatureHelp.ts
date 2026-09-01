import type * as Parser from 'tree-sitter';
import type {
  AnalyzedDocument,
  AnalysisPosition,
  AnalysisSignatureHelp
} from '../types/analysis';
import { createAxelParser } from './axelParser';
import { findNavigationTargetDeclaration, type WorkspaceNavigationIndex } from './navigation';
import { findSmallestNamedNodeAtPosition, nodeToAnalysisRange } from './syntaxTree';
import { comparePositions, contains, positionBeforeOrEqual } from './resolution';

export interface SignatureHelpInput {
  analysis: AnalyzedDocument;
  text: string;
  position: AnalysisPosition;
  workspaceIndex: WorkspaceNavigationIndex;
}

export function getSignatureHelp(input: SignatureHelpInput): AnalysisSignatureHelp | null {
  const call = findEnclosingCallExpression(input.text, input.position);
  if (call === undefined) {
    return null;
  }

  const target = callTargetNameNode(call.childForFieldName('function'));
  if (target === undefined) {
    return null;
  }

  const declaration = findNavigationTargetDeclaration({
    analysis: input.analysis,
    position: nodeToAnalysisRange(target).start,
    workspaceIndex: input.workspaceIndex
  });
  if (declaration?.signature === undefined) {
    return null;
  }

  return {
    signatures: [declaration.signature],
    activeSignature: 0,
    activeParameter: activeParameterIndex(call, input.position)
  };
}

function findEnclosingCallExpression(
  text: string,
  position: AnalysisPosition
): Parser.SyntaxNode | undefined {
  const tree = createAxelParser().parse(text);
  let node = findSmallestNamedNodeAtPosition(tree.rootNode, position);

  while (node !== null) {
    if (node.type === 'call_expression' && positionInArguments(node, position)) {
      return node;
    }

    node = node.parent;
  }

  return undefined;
}

function positionInArguments(callExpression: Parser.SyntaxNode, position: AnalysisPosition): boolean {
  const argumentsNode = callExpression.childForFieldName('arguments');
  return argumentsNode !== null && contains(nodeToAnalysisRange(argumentsNode), position);
}

function activeParameterIndex(callExpression: Parser.SyntaxNode, position: AnalysisPosition): number {
  const argumentsNode = callExpression.childForFieldName('arguments');
  if (argumentsNode === null) {
    return 0;
  }

  let commaCount = 0;
  for (let index = 0; index < argumentsNode.childCount; index += 1) {
    const child = argumentsNode.child(index);
    if (child?.text === ',' && positionBeforeOrEqual(pointToPosition(child.endPosition), position)) {
      commaCount += 1;
    }
  }

  return commaCount;
}

function callTargetNameNode(node: Parser.SyntaxNode | null): Parser.SyntaxNode | undefined {
  if (node === null) {
    return undefined;
  }

  if (isCallTargetNameNode(node)) {
    return node;
  }

  const field = node.type === 'field_expression' ? node.childForFieldName('field') : null;
  if (field !== null && isCallTargetNameNode(field)) {
    return field;
  }

  return [...node.namedChildren]
    .sort((left, right) => comparePositions(nodeToAnalysisRange(right).start, nodeToAnalysisRange(left).start))
    .map(callTargetNameNode)
    .find((target): target is Parser.SyntaxNode => target !== undefined);
}

function isCallTargetNameNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'identifier'
    || node.type === 'class_name'
    || node.type === 'gtop_class'
    || node.type === 'gins_class'
    || node.type === 'member_identifier';
}

function pointToPosition(point: Parser.Point): AnalysisPosition {
  return {
    line: point.row,
    character: point.column
  };
}
