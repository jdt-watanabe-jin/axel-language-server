"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prepareRename = prepareRename;
exports.getRenameEdits = getRenameEdits;
const builtins_1 = require("./builtins");
const navigation_1 = require("./navigation");
const resolution_1 = require("./resolution");
function prepareRename(input) {
    const target = findSafeRenameTarget(input);
    return target === undefined ? null : rangeAtPosition(input, target);
}
function getRenameEdits(input) {
    const target = findSafeRenameTarget(input);
    if (target === undefined) {
        return { reason: 'This symbol cannot be renamed.' };
    }
    if (!isIdentifierName(input.newName)) {
        return { reason: `Invalid AXEL identifier '${input.newName}'.` };
    }
    const references = (0, navigation_1.getReferences)({
        analysis: input.analysis,
        position: input.position,
        includeDeclaration: true,
        workspaceIndex: input.workspaceIndex
    });
    const changes = {};
    for (const location of references) {
        changes[location.uri] ??= [];
        changes[location.uri].push({
            range: location.range,
            newText: input.newName
        });
    }
    return {
        changes: sortChanges(changes)
    };
}
function findSafeRenameTarget(input) {
    const target = (0, navigation_1.findNavigationTargetDeclaration)(input);
    if (target === undefined || isUnsafeRenameDeclaration(target)) {
        return undefined;
    }
    if (hasAmbiguousVisibleDeclaration(input.workspaceIndex, input.analysis.uri, target)) {
        return undefined;
    }
    return target;
}
function isUnsafeRenameDeclaration(declaration) {
    return declaration.kind === 'include'
        || declaration.kind === 'macro'
        || (0, builtins_1.getBuiltinHover)(declaration.name) !== null;
}
function hasAmbiguousVisibleDeclaration(workspaceIndex, sourceUri, target) {
    const declarations = workspaceIndex.findVisibleDeclarations?.(sourceUri, target.name) ?? [];
    return declarations.some((declaration) => (declaration.id !== target.id
        && declaration.kind === target.kind
        && declaration.containerName === target.containerName));
}
function rangeAtPosition(input, target) {
    const reference = input.analysis.references.find((candidate) => (candidate.name === target.name && contains(candidate.range, input.position)));
    return reference?.range ?? target.selectionRange;
}
function sortChanges(changes) {
    return Object.fromEntries(Object.entries(changes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([uri, edits]) => [
        uri,
        edits.sort((left, right) => (0, resolution_1.comparePositions)(left.range.start, right.range.start))
    ]));
}
function isIdentifierName(name) {
    return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(name);
}
function contains(range, position) {
    return (0, resolution_1.comparePositions)(range.start, position) <= 0 && (0, resolution_1.comparePositions)(position, range.end) < 0;
}
//# sourceMappingURL=rename.js.map