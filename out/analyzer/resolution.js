"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findLocalDeclaration = findLocalDeclaration;
exports.findVisibleDeclaration = findVisibleDeclaration;
exports.listVisibleDeclarations = listVisibleDeclarations;
exports.visibleDeclarationsByName = visibleDeclarationsByName;
exports.declarationsInTypeHierarchy = declarationsInTypeHierarchy;
exports.findDeclarationMember = findDeclarationMember;
exports.resolveMemberAccessType = resolveMemberAccessType;
exports.receiverTypeName = receiverTypeName;
exports.thisReceiverType = thisReceiverType;
exports.isTypeDeclaration = isTypeDeclaration;
exports.isVisibleAt = isVisibleAt;
exports.findInnermostScope = findInnermostScope;
exports.contains = contains;
exports.positionBeforeOrEqual = positionBeforeOrEqual;
exports.positionBefore = positionBefore;
exports.comparePositions = comparePositions;
exports.compareDeclarations = compareDeclarations;
exports.rangeSize = rangeSize;
function findLocalDeclaration(analysis, name, position) {
    const declarations = new Map(analysis.declarations.map((declaration) => [declaration.id, declaration]));
    let scope = findInnermostScope(analysis.scopes, position);
    while (scope !== undefined) {
        const declaration = scope.declarationIds
            .map((id) => declarations.get(id))
            .filter((item) => (item?.name === name && isVisibleAt(item, position, analysis.uri)))
            .sort((left, right) => comparePositions(right.selectionRange.start, left.selectionRange.start))[0];
        if (declaration !== undefined) {
            return declaration;
        }
        scope = analysis.scopes.find((item) => item.id === scope?.parentId);
    }
    return undefined;
}
function findVisibleDeclaration(input, name) {
    return findLocalDeclaration(input.analysis, name, input.position)
        ?? input.workspaceIndex.findVisibleDeclarations?.(input.analysis.uri, name)[0];
}
function listVisibleDeclarations(input) {
    const declarations = [
        ...input.analysis.declarations,
        ...(input.workspaceIndex.listVisibleDeclarations?.(input.analysis.uri) ?? [])
    ];
    return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
        .sort(compareDeclarations);
}
function visibleDeclarationsByName(input, name) {
    const listed = input.workspaceIndex.listVisibleDeclarations?.(input.analysis.uri);
    if (listed !== undefined) {
        return Array.from(new Map([
            ...input.analysis.declarations,
            ...listed
        ].map((declaration) => [declaration.id, declaration])).values())
            .filter((declaration) => declaration.name === name)
            .sort(compareDeclarations);
    }
    return [
        ...input.analysis.declarations.filter((declaration) => declaration.name === name),
        ...(input.workspaceIndex.findVisibleDeclarations?.(input.analysis.uri, name) ?? [])
    ].sort(compareDeclarations);
}
function declarationsInTypeHierarchy(input, typeName) {
    const declarations = [];
    const visited = new Set();
    function visit(currentTypeName) {
        if (visited.has(currentTypeName)) {
            return;
        }
        visited.add(currentTypeName);
        const visible = listVisibleDeclarations(input);
        declarations.push(...visible.filter((declaration) => (declaration.containerName === currentTypeName)));
        declarations.push(...recoveredStaticMemberDeclarations(visible, currentTypeName));
        const baseName = visible
            .find((declaration) => isTypeDeclaration(declaration) && declaration.name === currentTypeName)
            ?.baseName;
        if (baseName !== undefined) {
            visit(baseName);
        }
    }
    visit(typeName);
    return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
        .sort(compareDeclarations);
}
function findDeclarationMember(input, containerName, memberName) {
    return declarationsInTypeHierarchy(input, containerName)
        .filter((declaration) => declaration.name === memberName)
        .sort(compareDeclarations)[0];
}
function resolveMemberAccessType(input, rootTypeName, path) {
    let typeName = rootTypeName;
    for (const memberName of path) {
        if (typeName === undefined) {
            return undefined;
        }
        typeName = findDeclarationMember(input, typeName, memberName)?.typeName;
    }
    return typeName;
}
function receiverTypeName(input, receiverName) {
    return (findLocalDeclaration(input.analysis, receiverName, input.position)
        ?? visibleDeclarationsByName(input, receiverName)[0])
        ?.typeName;
}
function recoveredStaticMemberDeclarations(declarations, containerName) {
    return declarations
        .filter((declaration) => declaration.containerName === undefined)
        .filter((declaration) => declaration.detail.startsWith('static '))
        .filter((declaration) => recoveredStaticMemberOwner(declarations, declaration)?.name === containerName)
        .map((declaration) => ({ ...declaration, containerName }));
}
function recoveredStaticMemberOwner(declarations, member) {
    return declarations
        .filter(isTypeDeclaration)
        .filter((declaration) => declaration.uri === member.uri)
        .filter((declaration) => positionBefore(declaration.selectionRange.start, member.selectionRange.start))
        .sort((left, right) => comparePositions(right.selectionRange.start, left.selectionRange.start))[0];
}
function thisReceiverType(input) {
    const containingDeclarations = input.analysis.declarations
        .filter((declaration) => contains(declaration.range, input.position))
        .sort((left, right) => rangeSize(left.range) - rangeSize(right.range));
    const method = containingDeclarations.find((declaration) => (declaration.kind === 'function' && declaration.containerName !== undefined));
    if (method?.containerName !== undefined) {
        return method.containerName;
    }
    return containingDeclarations.find(isTypeDeclaration)?.name;
}
function isTypeDeclaration(declaration) {
    return declaration.kind === 'class'
        || declaration.kind === 'struct'
        || declaration.kind === 'union'
        || declaration.kind === 'enum'
        || declaration.kind === 'typedef';
}
function isVisibleAt(declaration, position, sourceUri) {
    return declaration.uri !== sourceUri || positionBeforeOrEqual(declaration.selectionRange.start, position);
}
function findInnermostScope(scopes, position) {
    return scopes
        .filter((scope) => contains(scope.range, position))
        .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
}
function contains(range, position) {
    return positionBeforeOrEqual(range.start, position) && positionBefore(position, range.end);
}
function positionBeforeOrEqual(left, right) {
    return left.line < right.line || (left.line === right.line && left.character <= right.character);
}
function positionBefore(left, right) {
    return left.line < right.line || (left.line === right.line && left.character < right.character);
}
function comparePositions(left, right) {
    return left.line - right.line || left.character - right.character;
}
function compareDeclarations(left, right) {
    return left.uri.localeCompare(right.uri)
        || comparePositions(left.selectionRange.start, right.selectionRange.start)
        || comparePositions(left.selectionRange.end, right.selectionRange.end);
}
function rangeSize(range) {
    return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
}
//# sourceMappingURL=resolution.js.map