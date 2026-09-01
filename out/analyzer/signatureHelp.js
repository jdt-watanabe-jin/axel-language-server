"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSignatureHelp = getSignatureHelp;
const axelParser_1 = require("./axelParser");
const navigation_1 = require("./navigation");
const syntaxTree_1 = require("./syntaxTree");
const resolution_1 = require("./resolution");
function getSignatureHelp(input) {
    const call = findEnclosingCallExpression(input.text, input.position);
    if (call === undefined) {
        return null;
    }
    const target = callTargetNameNode(call.childForFieldName('function'));
    if (target === undefined) {
        return null;
    }
    const declaration = (0, navigation_1.findNavigationTargetDeclaration)({
        analysis: input.analysis,
        position: (0, syntaxTree_1.nodeToAnalysisRange)(target).start,
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
function findEnclosingCallExpression(text, position) {
    const tree = (0, axelParser_1.createAxelParser)().parse(text);
    let node = (0, syntaxTree_1.findSmallestNamedNodeAtPosition)(tree.rootNode, position);
    while (node !== null) {
        if (node.type === 'call_expression' && positionInArguments(node, position)) {
            return node;
        }
        node = node.parent;
    }
    return undefined;
}
function positionInArguments(callExpression, position) {
    const argumentsNode = callExpression.childForFieldName('arguments');
    return argumentsNode !== null && (0, resolution_1.contains)((0, syntaxTree_1.nodeToAnalysisRange)(argumentsNode), position);
}
function activeParameterIndex(callExpression, position) {
    const argumentsNode = callExpression.childForFieldName('arguments');
    if (argumentsNode === null) {
        return 0;
    }
    let commaCount = 0;
    for (let index = 0; index < argumentsNode.childCount; index += 1) {
        const child = argumentsNode.child(index);
        if (child?.text === ',' && (0, resolution_1.positionBeforeOrEqual)(pointToPosition(child.endPosition), position)) {
            commaCount += 1;
        }
    }
    return commaCount;
}
function callTargetNameNode(node) {
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
        .sort((left, right) => (0, resolution_1.comparePositions)((0, syntaxTree_1.nodeToAnalysisRange)(right).start, (0, syntaxTree_1.nodeToAnalysisRange)(left).start))
        .map(callTargetNameNode)
        .find((target) => target !== undefined);
}
function isCallTargetNameNode(node) {
    return node.type === 'identifier'
        || node.type === 'class_name'
        || node.type === 'gtop_class'
        || node.type === 'gins_class'
        || node.type === 'member_identifier';
}
function pointToPosition(point) {
    return {
        line: point.row,
        character: point.column
    };
}
//# sourceMappingURL=signatureHelp.js.map