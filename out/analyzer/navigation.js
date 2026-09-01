"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefinitions = getDefinitions;
exports.getReferences = getReferences;
exports.findNavigationTargetDeclaration = findNavigationTargetDeclaration;
const resolution_1 = require("./resolution");
function getDefinitions(input) {
    const include = input.workspaceIndex.resolveIncludeAtPosition?.(input.analysis.uri, input.position);
    if (include !== undefined) {
        return [{
                uri: include.uri,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 }
                }
            }];
    }
    const execution = input.workspaceIndex.resolveScriptExecutionAtPosition?.(input.analysis.uri, input.position);
    if (execution !== undefined) {
        return [{
                uri: execution.uri,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 }
                }
            }];
    }
    const declaration = findNavigationTargetDeclaration(input);
    return declaration === undefined ? [] : [locationFromDeclaration(declaration)];
}
function getReferences(input) {
    const target = findNavigationTargetDeclaration(input);
    if (target === undefined) {
        return [];
    }
    const documents = referenceSearchDocuments(input);
    const locations = documents.flatMap((analysis) => referencesToDeclaration(input, analysis, target));
    if (input.includeDeclaration) {
        locations.push(locationFromDeclaration(target));
    }
    return uniqueLocations(locations).sort(compareLocations);
}
function findNavigationTargetDeclaration(input) {
    const declaration = findDeclarationAtPosition(input.analysis, input.position);
    if (declaration !== undefined) {
        return declaration;
    }
    const guiReceiverDeclaration = findGuiReceiverPathDeclaration(input);
    if (guiReceiverDeclaration !== undefined) {
        return guiReceiverDeclaration;
    }
    const reference = findReferenceAtPosition(input.analysis, input.position);
    if (reference === undefined) {
        return undefined;
    }
    const preferredImplicitGuiDeclaration = findPreferredImplicitGuiReferenceDeclaration(input, reference);
    if (preferredImplicitGuiDeclaration !== undefined) {
        return preferredImplicitGuiDeclaration;
    }
    const ordinaryDeclaration = findDeclarationForReference(input, reference);
    return ordinaryDeclaration ?? findImplicitGuiReferenceDeclaration(input, reference);
}
function referencesToDeclaration(navigationInput, analysis, target) {
    const locations = [];
    for (const reference of analysis.references) {
        const declaration = findNavigationTargetDeclaration({
            analysis,
            position: reference.range.start,
            workspaceIndex: navigationInput.workspaceIndex
        });
        if (declaration?.id === target.id) {
            locations.push(locationFromReference(reference));
        }
    }
    return locations;
}
function findDeclarationAtPosition(analysis, position) {
    return analysis.declarations.find((declaration) => (0, resolution_1.contains)(declaration.selectionRange, position));
}
function findReferenceAtPosition(analysis, position) {
    return analysis.references.find((reference) => (0, resolution_1.contains)(reference.range, position));
}
function findPreferredImplicitGuiReferenceDeclaration(input, reference) {
    if (reference.memberAccess === undefined) {
        const localDeclaration = (0, resolution_1.findLocalDeclaration)(input.analysis, reference.name, input.position);
        return localDeclaration === undefined ? findImplicitGuiReferenceDeclaration(input, reference) : undefined;
    }
    const localReceiver = (0, resolution_1.findLocalDeclaration)(input.analysis, reference.memberAccess.receiverName, input.position);
    return localReceiver === undefined && typeDeclarationName(input, reference.memberAccess.receiverName) === undefined
        ? findImplicitGuiReferenceDeclaration(input, reference)
        : undefined;
}
function findDeclarationForReference(input, reference) {
    if (reference.memberAccess !== undefined) {
        return findMemberDeclaration(input, reference.memberAccess);
    }
    return (0, resolution_1.findVisibleDeclaration)(input, reference.name);
}
function findMemberDeclaration(input, memberAccess) {
    let typeName = memberAccess.receiverName === 'this'
        ? (0, resolution_1.thisReceiverType)(input)
        : (0, resolution_1.findVisibleDeclaration)(input, memberAccess.receiverName)?.typeName
            ?? typeDeclarationName(input, memberAccess.receiverName);
    let memberDeclaration;
    for (const memberName of memberAccess.memberNames) {
        if (typeName === undefined) {
            return undefined;
        }
        memberDeclaration = findDeclarationMember(input, typeName, memberName);
        typeName = memberDeclaration?.typeName;
    }
    return memberDeclaration;
}
function findImplicitGuiReferenceDeclaration(input, reference) {
    const context = findEnclosingGuiMethodContext(input);
    if (context === undefined) {
        return undefined;
    }
    if (reference.memberAccess !== undefined) {
        return findImplicitGuiMemberAccessDeclaration(input, context, reference.memberAccess);
    }
    const part = resolveGuiPartPath(input, context.rootClassName, [reference.name]);
    if (part !== undefined) {
        return findDeclarationForGuiPart(input, part);
    }
    return findDeclarationMember(input, context.receiverTypeName, reference.name)
        ?? findDeclarationMember(input, context.rootClassName, reference.name);
}
function findImplicitGuiMemberAccessDeclaration(input, context, memberAccess) {
    const path = [memberAccess.receiverName, ...memberAccess.memberNames];
    const partPrefix = resolveLongestGuiPartPath(input, context.rootClassName, path);
    if (partPrefix === undefined) {
        return undefined;
    }
    if (partPrefix.length === path.length) {
        return findDeclarationForGuiPart(input, partPrefix.part);
    }
    const memberName = path.at(-1);
    return memberName === undefined
        ? undefined
        : findDeclarationMember(input, partPrefix.part.part.typeName, memberName);
}
function findGuiReceiverPathDeclaration(input) {
    for (const method of allGuiMethods(input.analysis)) {
        const segmentIndex = segmentIndexAtPosition(method, input.position);
        if (segmentIndex === undefined) {
            continue;
        }
        if (segmentIndex === 0) {
            return (0, resolution_1.findVisibleDeclaration)(input, method.receiverPath[0]);
        }
        const part = resolveGuiPartPath(input, method.receiverPath[0], method.receiverPath.slice(1, segmentIndex + 1));
        if (part !== undefined) {
            return findDeclarationForGuiPart(input, part);
        }
    }
    return undefined;
}
function findDeclarationMember(input, containerName, memberName) {
    return findDeclarationMemberInHierarchy(input, containerName, memberName, new Set());
}
function findDeclarationMemberInHierarchy(input, containerName, memberName, visitedContainerNames) {
    if (visitedContainerNames.has(containerName)) {
        return undefined;
    }
    visitedContainerNames.add(containerName);
    const member = visibleDeclarations(input, memberName)
        .filter((declaration) => declaration.containerName === containerName)
        .sort(resolution_1.compareDeclarations)[0];
    if (member !== undefined) {
        return member;
    }
    const baseName = visibleDeclarations(input, containerName)
        .filter(resolution_1.isTypeDeclaration)
        .sort(resolution_1.compareDeclarations)[0]?.baseName;
    if (baseName !== undefined) {
        const baseMember = findDeclarationMemberInHierarchy(input, baseName, memberName, visitedContainerNames);
        if (baseMember !== undefined) {
            return baseMember;
        }
    }
    return findRecoveredGuiDeclarationMember(input, containerName, memberName)
        ?? findRecoveredStaticMember(input, containerName, memberName);
}
function findRecoveredGuiDeclarationMember(input, containerName, memberName) {
    if (!/^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(containerName)) {
        return undefined;
    }
    return visibleDeclarations(input, memberName)
        .filter((declaration) => declaration.containerName === undefined && isRecoveredGuiMember(declaration, memberName))
        .sort(resolution_1.compareDeclarations)[0];
}
function isRecoveredGuiMember(declaration, memberName) {
    return declaration.detail.includes(`${memberName}(`) || declaration.detail.endsWith(memberName);
}
function findRecoveredStaticMember(input, containerName, memberName) {
    return visibleDeclarations(input, memberName)
        .filter((declaration) => declaration.containerName === undefined)
        .filter((declaration) => declaration.detail.startsWith('static '))
        .filter((declaration) => recoveredStaticMemberOwner(input, declaration)?.name === containerName)
        .map((declaration) => ({ ...declaration, containerName }))
        .sort(resolution_1.compareDeclarations)[0];
}
function recoveredStaticMemberOwner(input, member) {
    return input.workspaceIndex.listVisibleDeclarations?.(input.analysis.uri)
        .filter(resolution_1.isTypeDeclaration)
        .filter((declaration) => declaration.uri === member.uri)
        .filter((declaration) => (0, resolution_1.comparePositions)(declaration.selectionRange.start, member.selectionRange.start) < 0)
        .sort((left, right) => (0, resolution_1.comparePositions)(right.selectionRange.start, left.selectionRange.start))[0];
}
function findEnclosingGuiMethodContext(input) {
    for (const guiClass of input.analysis.guiClasses) {
        const context = findEnclosingGuiMethodContextInClass(input, guiClass);
        if (context !== undefined) {
            return context;
        }
    }
    for (const method of input.analysis.guiMethods) {
        const context = guiMethodContextFromReceiverPath(input, method);
        if (context !== undefined && (0, resolution_1.contains)(method.range, input.position)) {
            return context;
        }
    }
    return undefined;
}
function findEnclosingGuiMethodContextInClass(input, guiClass) {
    const classMethod = guiClass.methods.find((method) => (0, resolution_1.contains)(method.range, input.position));
    if (classMethod !== undefined) {
        return guiMethodContextFromReceiverPath(input, classMethod)
            ?? { rootClassName: guiClass.name, receiverTypeName: guiClass.name };
    }
    const partMethod = findEnclosingGuiPartMethod(guiClass.parts, input.position);
    if (partMethod !== undefined) {
        return { rootClassName: guiClass.name, receiverTypeName: partMethod.part.typeName };
    }
    return undefined;
}
function findEnclosingGuiPartMethod(parts, position) {
    for (const part of parts) {
        const method = part.methods.find((candidate) => (0, resolution_1.contains)(candidate.range, position));
        if (method !== undefined) {
            return { part, method };
        }
        const childMethod = findEnclosingGuiPartMethod(part.parts, position);
        if (childMethod !== undefined) {
            return childMethod;
        }
    }
    return undefined;
}
function guiMethodContextFromReceiverPath(input, method) {
    const rootClassName = method.receiverPath[0];
    if (rootClassName === undefined) {
        return undefined;
    }
    const partPath = method.receiverPath.slice(1, -1);
    if (partPath.length === 0) {
        return { rootClassName, receiverTypeName: rootClassName };
    }
    const part = resolveGuiPartPath(input, rootClassName, partPath);
    return part === undefined ? undefined : { rootClassName, receiverTypeName: part.part.typeName };
}
function resolveGuiPartPath(input, rootClassName, path) {
    let owner = findVisibleGuiClassEntry(input, rootClassName);
    let ownerPath = [];
    let resolved;
    const rootOwner = owner;
    if (rootOwner !== undefined) {
        const directPart = findPartByPath(rootOwner.guiClass.parts, path);
        if (directPart !== undefined) {
            return { ownerUri: rootOwner.uri, ownerName: rootOwner.guiClass.name, part: directPart };
        }
    }
    for (const segment of path) {
        if (owner === undefined) {
            return undefined;
        }
        const nextPath = [...ownerPath, segment];
        const part = findPartByPath(owner.guiClass.parts, nextPath) ?? findPartByPath(owner.guiClass.parts, [segment]);
        if (part === undefined) {
            return undefined;
        }
        resolved = { ownerUri: owner.uri, ownerName: owner.guiClass.name, part };
        const partClass = findVisibleGuiClassEntry(input, part.typeName);
        owner = partClass ?? owner;
        ownerPath = partClass === undefined ? nextPath : [];
    }
    return resolved;
}
function resolveLongestGuiPartPath(input, rootClassName, path) {
    for (let length = path.length; length > 0; length -= 1) {
        const part = resolveGuiPartPath(input, rootClassName, path.slice(0, length));
        if (part !== undefined) {
            return { length, part };
        }
    }
    return undefined;
}
function findVisibleGuiClassEntry(input, name) {
    for (const analysis of visibleDocuments(input)) {
        const guiClass = analysis.guiClasses.find((candidate) => candidate.name === name);
        if (guiClass !== undefined) {
            return { uri: analysis.uri, guiClass };
        }
    }
    const guiClass = input.workspaceIndex.findGuiClass?.(input.analysis.uri, name);
    return guiClass === undefined ? undefined : { guiClass };
}
function findPartByPath(parts, path) {
    for (const part of parts) {
        if (sameStringArray(part.path, path)) {
            return part;
        }
        const child = findPartByPath(part.parts, path);
        if (child !== undefined) {
            return child;
        }
    }
    return undefined;
}
function findDeclarationForGuiPart(input, resolved) {
    if (resolved.part.name === undefined) {
        return undefined;
    }
    for (const analysis of visibleDocuments(input)) {
        if (resolved.ownerUri !== undefined && analysis.uri !== resolved.ownerUri) {
            continue;
        }
        const ownerClass = analysis.guiClasses.find((guiClass) => (guiClass.name === resolved.ownerName && guiClassContainsPart(guiClass, resolved.part)));
        if (ownerClass === undefined) {
            continue;
        }
        const declaration = analysis.declarations.find((candidate) => (candidate.name === resolved.part.name && sameRange(candidate.range, resolved.part.range)));
        if (declaration !== undefined) {
            return declaration;
        }
    }
    return undefined;
}
function guiClassContainsPart(guiClass, target) {
    return findPartByPath(guiClass.parts, target.path) !== undefined;
}
function visibleDeclarations(input, name) {
    return (0, resolution_1.visibleDeclarationsByName)(input, name);
}
function typeDeclarationName(input, name) {
    return visibleDeclarations(input, name)
        .find(resolution_1.isTypeDeclaration)
        ?.name;
}
function visibleDocuments(input) {
    const documents = [
        input.analysis,
        ...(input.workspaceIndex.listVisibleDocuments?.(input.analysis.uri) ?? [])
    ];
    return Array.from(new Map(documents.map((analysis) => [analysis.uri, analysis])).values());
}
function referenceSearchDocuments(input) {
    const documents = [
        input.analysis,
        ...(input.workspaceIndex.listReferenceSearchDocuments?.(input.analysis.uri) ?? visibleDocuments(input))
    ];
    return Array.from(new Map(documents.map((analysis) => [analysis.uri, analysis])).values());
}
function allGuiMethods(analysis) {
    return [
        ...analysis.guiMethods,
        ...analysis.guiClasses.flatMap((guiClass) => guiClass.methods)
    ];
}
function segmentIndexAtPosition(method, position) {
    const segmentIndex = method.receiverPathSegmentRanges
        ?.findIndex((range) => (0, resolution_1.contains)(range, position));
    return segmentIndex === undefined || segmentIndex < 0 ? undefined : segmentIndex;
}
function locationFromDeclaration(declaration) {
    return {
        uri: declaration.uri,
        range: declaration.selectionRange
    };
}
function locationFromReference(reference) {
    return {
        uri: reference.uri,
        range: reference.range
    };
}
function uniqueLocations(locations) {
    return Array.from(new Map(locations.map((location) => [locationKey(location), location])).values());
}
function locationKey(location) {
    return [
        location.uri,
        location.range.start.line,
        location.range.start.character,
        location.range.end.line,
        location.range.end.character
    ].join(':');
}
function compareLocations(left, right) {
    return left.uri.localeCompare(right.uri)
        || (0, resolution_1.comparePositions)(left.range.start, right.range.start)
        || (0, resolution_1.comparePositions)(left.range.end, right.range.end);
}
function sameRange(left, right) {
    return samePosition(left.start, right.start) && samePosition(left.end, right.end);
}
function samePosition(left, right) {
    return left.line === right.line && left.character === right.character;
}
function sameStringArray(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}
//# sourceMappingURL=navigation.js.map