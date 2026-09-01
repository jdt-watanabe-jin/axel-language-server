import type * as Parser from 'tree-sitter';
import type {
  AnalysisDeclaration,
  AnalysisDocumentUri,
  AnalysisRange,
  AnalysisScope,
  AnalysisSymbolId
} from '../types/analysis';
import { nodeToAnalysisRange } from './syntaxTree';

const SCOPE_NODE_TYPES = new Set([
  'field_declaration_list',
  'function_definition',
  'compound_statement',
  'gins_definition'
]);

export function buildScopeIndex(
  rootNode: Parser.SyntaxNode,
  uri: AnalysisDocumentUri,
  declarations: AnalysisDeclaration[]
): AnalysisScope[] {
  const scopes = [createScope(uri, 'global', undefined, nodeToAnalysisRange(rootNode))];

  collectNestedScopes(rootNode, uri, scopes[0].id, scopes);
  assignDeclarations(scopes, declarations);
  return scopes;
}

function collectNestedScopes(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri,
  parentId: AnalysisSymbolId,
  scopes: AnalysisScope[]
): void {
  for (const child of node.namedChildren) {
    const isScope = SCOPE_NODE_TYPES.has(child.type);
    const scope = isScope
      ? createScope(uri, `${child.startPosition.row}:${child.startPosition.column}`, parentId, nodeToAnalysisRange(child))
      : undefined;

    if (scope !== undefined) {
      scopes.push(scope);
    }

    collectNestedScopes(child, uri, scope?.id ?? parentId, scopes);
  }
}

function createScope(
  uri: AnalysisDocumentUri,
  suffix: string,
  parentId: AnalysisSymbolId | undefined,
  range: AnalysisRange
): AnalysisScope {
  return {
    id: `${uri}#scope:${suffix}`,
    parentId,
    range,
    declarationIds: []
  };
}

function assignDeclarations(scopes: AnalysisScope[], declarations: AnalysisDeclaration[]): void {
  for (const declaration of declarations) {
    const scope = declaration.kind === 'function' || isOwnContainerDeclaration(scopes, declaration.range)
      ? findParentScope(scopes, declaration.selectionRange)
      : findInnermostScope(scopes, declaration.selectionRange);
    scope.declarationIds.push(declaration.id);
  }
}

function isOwnContainerDeclaration(scopes: AnalysisScope[], range: AnalysisRange): boolean {
  return scopes.some((scope) => rangesEqual(scope.range, range));
}

function rangesEqual(left: AnalysisRange, right: AnalysisRange): boolean {
  return positionsEqual(left.start, right.start) && positionsEqual(left.end, right.end);
}

function positionsEqual(left: AnalysisRange['start'], right: AnalysisRange['start']): boolean {
  return left.line === right.line && left.character === right.character;
}

function findParentScope(scopes: AnalysisScope[], range: AnalysisRange): AnalysisScope {
  const scope = findInnermostScope(scopes, range);
  return scopes.find((candidate) => candidate.id === scope.parentId) ?? scope;
}

function findInnermostScope(scopes: AnalysisScope[], range: AnalysisRange): AnalysisScope {
  return scopes
    .filter((scope) => contains(scope.range, range))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
}

function contains(container: AnalysisRange, range: AnalysisRange): boolean {
  return positionBeforeOrEqual(container.start, range.start)
    && positionBeforeOrEqual(range.end, container.end);
}

function positionBeforeOrEqual(
  left: AnalysisRange['start'],
  right: AnalysisRange['start']
): boolean {
  return left.line < right.line || (left.line === right.line && left.character <= right.character);
}

function rangeSize(range: AnalysisRange): number {
  return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
}
