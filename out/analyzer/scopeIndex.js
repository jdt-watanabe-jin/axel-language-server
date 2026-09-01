"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildScopeIndex = buildScopeIndex;
const syntaxTree_1 = require("./syntaxTree");
const SCOPE_NODE_TYPES = new Set([
    'field_declaration_list',
    'function_definition',
    'compound_statement',
    'gins_definition'
]);
function buildScopeIndex(rootNode, uri, declarations) {
    const scopes = [createScope(uri, 'global', undefined, (0, syntaxTree_1.nodeToAnalysisRange)(rootNode))];
    collectNestedScopes(rootNode, uri, scopes[0].id, scopes);
    assignDeclarations(scopes, declarations);
    return scopes;
}
function collectNestedScopes(node, uri, parentId, scopes) {
    for (const child of node.namedChildren) {
        const isScope = SCOPE_NODE_TYPES.has(child.type);
        const scope = isScope
            ? createScope(uri, `${child.startPosition.row}:${child.startPosition.column}`, parentId, (0, syntaxTree_1.nodeToAnalysisRange)(child))
            : undefined;
        if (scope !== undefined) {
            scopes.push(scope);
        }
        collectNestedScopes(child, uri, scope?.id ?? parentId, scopes);
    }
}
function createScope(uri, suffix, parentId, range) {
    return {
        id: `${uri}#scope:${suffix}`,
        parentId,
        range,
        declarationIds: []
    };
}
function assignDeclarations(scopes, declarations) {
    for (const declaration of declarations) {
        const scope = declaration.kind === 'function' || isOwnContainerDeclaration(scopes, declaration.range)
            ? findParentScope(scopes, declaration.selectionRange)
            : findInnermostScope(scopes, declaration.selectionRange);
        scope.declarationIds.push(declaration.id);
    }
}
function isOwnContainerDeclaration(scopes, range) {
    return scopes.some((scope) => rangesEqual(scope.range, range));
}
function rangesEqual(left, right) {
    return positionsEqual(left.start, right.start) && positionsEqual(left.end, right.end);
}
function positionsEqual(left, right) {
    return left.line === right.line && left.character === right.character;
}
function findParentScope(scopes, range) {
    const scope = findInnermostScope(scopes, range);
    return scopes.find((candidate) => candidate.id === scope.parentId) ?? scope;
}
function findInnermostScope(scopes, range) {
    return scopes
        .filter((scope) => contains(scope.range, range))
        .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
}
function contains(container, range) {
    return positionBeforeOrEqual(container.start, range.start)
        && positionBeforeOrEqual(range.end, container.end);
}
function positionBeforeOrEqual(left, right) {
    return left.line < right.line || (left.line === right.line && left.character <= right.character);
}
function rangeSize(range) {
    return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
}
//# sourceMappingURL=scopeIndex.js.map