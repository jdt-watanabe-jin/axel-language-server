"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nodeToAnalysisRange = nodeToAnalysisRange;
exports.findNamedNodes = findNamedNodes;
exports.findSmallestNamedNodeAtPosition = findSmallestNamedNodeAtPosition;
exports.getDeclaratorName = getDeclaratorName;
function nodeToAnalysisRange(node) {
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
function findNamedNodes(rootNode, predicate) {
    const results = [];
    function visit(node) {
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
function findSmallestNamedNodeAtPosition(rootNode, position) {
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
function getDeclaratorName(node) {
    const named = node.childForFieldName('name');
    if (named !== null) {
        return named;
    }
    const declarator = node.childForFieldName('declarator');
    if (declarator === null) {
        return null;
    }
    return findInnermostDeclaratorName(declarator);
}
function findInnermostDeclaratorName(node) {
    if (isNameNode(node)) {
        return node;
    }
    const named = node.childForFieldName('name');
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
function isNameNode(node) {
    return [
        'identifier',
        'class_name',
        'qualified_declarator',
        'operator_declarator',
        'conversion_declarator'
    ].includes(node.type);
}
function containsPosition(node, position) {
    const range = nodeToAnalysisRange(node);
    return positionBeforeOrEqual(range.start, position) && positionBefore(position, range.end);
}
function positionBeforeOrEqual(left, right) {
    return left.line < right.line || (left.line === right.line && left.character <= right.character);
}
function positionBefore(left, right) {
    return left.line < right.line || (left.line === right.line && left.character < right.character);
}
//# sourceMappingURL=syntaxTree.js.map