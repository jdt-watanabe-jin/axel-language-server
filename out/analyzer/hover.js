"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHover = getHover;
const builtins_1 = require("./builtins");
const resolution_1 = require("./resolution");
function getHover(input) {
    const includeHover = findIncludeHover(input);
    if (includeHover !== undefined) {
        return includeHover;
    }
    const scriptExecutionHover = findScriptExecutionHover(input);
    if (scriptExecutionHover !== undefined) {
        return scriptExecutionHover;
    }
    const guiHover = findGuiHover(input);
    if (guiHover !== undefined) {
        return guiHover;
    }
    const declaration = findDeclarationAtPosition(input.analysis, input.position);
    if (declaration !== undefined) {
        return hoverForDeclaration(declaration);
    }
    const reference = findReferenceAtPosition(input.analysis, input.position);
    if (reference === undefined) {
        return null;
    }
    const preferredImplicitGuiHover = findPreferredImplicitGuiReferenceHover(input, reference);
    if (preferredImplicitGuiHover !== undefined) {
        return preferredImplicitGuiHover;
    }
    const referenceDeclaration = findDeclarationForReference(input);
    if (referenceDeclaration !== undefined) {
        return hoverForReferenceDeclaration(referenceDeclaration, reference);
    }
    const implicitGuiHover = findImplicitGuiReferenceHover(input, reference);
    if (implicitGuiHover !== undefined) {
        return implicitGuiHover;
    }
    return (0, builtins_1.getBuiltinHover)(reference.name);
}
function findIncludeHover(input) {
    const include = input.workspaceIndex.resolveIncludeAtPosition?.(input.analysis.uri, input.position);
    return include === undefined ? undefined : hoverFromText(`include: ${include.filePath}`, 'text');
}
function findScriptExecutionHover(input) {
    const execution = input.workspaceIndex.resolveScriptExecutionAtPosition?.(input.analysis.uri, input.position);
    return execution === undefined ? undefined : hoverFromText(`axel: ${execution.filePath}`, 'text');
}
function findPreferredImplicitGuiReferenceHover(input, reference) {
    const memberAccess = reference.memberAccess;
    if (memberAccess === undefined) {
        const localDeclaration = findLocalDeclaration(input.analysis, reference.name, input.position);
        return localDeclaration === undefined ? findImplicitGuiReferenceHover(input, reference) : undefined;
    }
    const localReceiver = findLocalDeclaration(input.analysis, memberAccess.receiverName, input.position);
    return localReceiver === undefined && typeDeclarationName(input, memberAccess.receiverName) === undefined
        ? findImplicitGuiReferenceHover(input, reference)
        : undefined;
}
function findDeclarationAtPosition(analysis, position) {
    return analysis.declarations.find((declaration) => contains(declaration.selectionRange, position));
}
function findDeclarationForReference(input) {
    const reference = findReferenceAtPosition(input.analysis, input.position);
    if (reference === undefined) {
        return undefined;
    }
    if (reference.memberAccess !== undefined) {
        return findMemberDeclaration(input, reference.memberAccess, input.position);
    }
    return findDeclarationByName(input, reference.name, input.position);
}
function findGuiHover(input) {
    const declaration = findDeclarationAtPosition(input.analysis, input.position);
    if (declaration !== undefined) {
        return findGuiDeclarationHover(input, declaration);
    }
    return findGuiReceiverPathHover(input)
        ?? findGuiReferenceHover(input)
        ?? findGuiBaseClassReferenceHover(input)
        ?? findGuiTypeReferenceHover(input);
}
function findGuiDeclarationHover(input, declaration) {
    const guiClass = findVisibleGuiClass(input, declaration.name);
    if (declaration.kind === 'class' && guiClass !== undefined) {
        return hoverFromText(guiClassText(guiClass));
    }
    const part = findGuiPartForDeclaration(input.analysis.guiClasses, declaration);
    if (part !== undefined) {
        return hoverFromText(guiPartText(part.ownerName, part.part));
    }
    const method = findGuiMethodForDeclaration(input.analysis, declaration);
    if (method === undefined) {
        return undefined;
    }
    return isResolvableGuiMethod(input, method) ? hoverFromText(declaration.detail) : null;
}
function findGuiReferenceHover(input) {
    const reference = findReferenceAtPosition(input.analysis, input.position);
    if (reference === undefined) {
        return undefined;
    }
    if (reference.memberAccess === undefined) {
        return undefined;
    }
    const part = resolveGuiMemberAccess(input, reference.memberAccess, input.position);
    return part === undefined ? undefined : hoverFromText(guiPartText(part.ownerName, part.part));
}
function findImplicitGuiReferenceHover(input, reference) {
    const context = findEnclosingGuiMethodContext(input);
    if (context === undefined) {
        return undefined;
    }
    if (reference.memberAccess !== undefined) {
        return hoverForImplicitGuiMemberAccess(input, context, reference.memberAccess);
    }
    const part = resolveGuiPartPath(input, context.rootClassName, [reference.name]);
    if (part !== undefined) {
        return hoverFromText(implicitGuiPartText(context.rootClassName, part.part));
    }
    const member = findImplicitGuiContextMember(input, context, reference.name);
    const ownerMember = member
        ?? findDeclarationMemberWithoutRecovery(input, context.rootClassName, reference.name, new Set());
    return ownerMember === undefined ? undefined : hoverFromText(hoverTextForMemberDeclaration(ownerMember));
}
function findImplicitGuiContextMember(input, context, memberName) {
    const recoveredMember = findRecoveredGuiDeclarationMember(input, context.receiverTypeName, memberName);
    return findDirectDeclarationMember(input, context.receiverTypeName, memberName)
        ?? (isImplicitGuiRecoveredMember(recoveredMember, memberName) ? recoveredMember : undefined)
        ?? findDeclarationMemberWithoutRecovery(input, context.receiverTypeName, memberName, new Set());
}
function isImplicitGuiRecoveredMember(declaration, memberName) {
    if (declaration === undefined) {
        return false;
    }
    return !declaration.detail.includes(`${memberName}(`) || /^On[A-Za-z_$][0-9A-Za-z_$]*$/.test(memberName);
}
function hoverForImplicitGuiMemberAccess(input, context, memberAccess) {
    const path = [memberAccess.receiverName, ...memberAccess.memberNames];
    const partPrefix = resolveLongestGuiPartPath(input, context.rootClassName, path);
    if (partPrefix === undefined) {
        return undefined;
    }
    if (partPrefix.length === path.length) {
        return hoverFromText(implicitGuiPartText(context.rootClassName, partPrefix.part.part));
    }
    const memberName = path.at(-1);
    if (memberName === undefined) {
        return undefined;
    }
    const member = findDeclarationMember(input, partPrefix.part.part.typeName, memberName);
    return member === undefined ? undefined : hoverFromText(hoverTextForMemberDeclaration(member));
}
function findGuiTypeReferenceHover(input) {
    const reference = findReferenceAtPosition(input.analysis, input.position);
    if (reference === undefined || reference.memberAccess !== undefined) {
        return undefined;
    }
    const guiClass = findVisibleGuiClass(input, reference.name);
    return guiClass === undefined ? undefined : hoverFromText(guiClassText(guiClass));
}
function findGuiBaseClassReferenceHover(input) {
    const reference = findReferenceAtPosition(input.analysis, input.position);
    if (reference === undefined) {
        return undefined;
    }
    if (reference.memberAccess !== undefined) {
        return undefined;
    }
    const declaringType = input.analysis.declarations.find((declaration) => (isTypeDeclaration(declaration)
        && declaration.baseName === reference.name
        && contains(declaration.range, reference.range.start)
        && isBeforeDeclarationBody(input.analysis, declaration, reference.range.start)));
    if (declaringType === undefined) {
        return undefined;
    }
    const baseGuiClass = findVisibleGuiClass(input, reference.name);
    return baseGuiClass?.baseName === undefined
        ? undefined
        : hoverFromText(`class ${baseGuiClass.baseName}`);
}
function isTypeDeclaration(declaration) {
    return declaration.kind === 'class' || declaration.kind === 'struct' || declaration.kind === 'union';
}
function isBeforeDeclarationBody(analysis, declaration, position) {
    const bodyScope = analysis.scopes
        .filter((scope) => contains(declaration.range, scope.range.start))
        .filter((scope) => positionBefore(declaration.selectionRange.start, scope.range.start))
        .sort((left, right) => comparePositions(left.range.start, right.range.start))[0];
    return bodyScope === undefined || positionBefore(position, bodyScope.range.start);
}
function findGuiReceiverPathHover(input) {
    for (const method of allGuiMethods(input.analysis)) {
        const segmentIndex = segmentIndexAtPosition(method, input.position);
        if (segmentIndex === undefined) {
            continue;
        }
        const rootClass = findVisibleGuiClass(input, method.receiverPath[0]);
        if (segmentIndex === 0 && rootClass !== undefined) {
            return hoverFromText(guiClassText(rootClass));
        }
        const part = resolveGuiPartPath(input, method.receiverPath[0], method.receiverPath.slice(1, segmentIndex + 1));
        if (part !== undefined) {
            return hoverFromText(guiPartText(part.ownerName, part.part));
        }
    }
    return undefined;
}
function findDeclarationByName(input, name, position) {
    return (0, resolution_1.findVisibleDeclaration)({ ...input, position }, name);
}
function findReferenceAtPosition(analysis, position) {
    return analysis.references.find((item) => contains(item.range, position));
}
function findMemberDeclaration(input, memberAccess, position) {
    let typeName = memberAccess.receiverName === 'this'
        ? (0, resolution_1.thisReceiverType)({ ...input, position })
        : findDeclarationByName(input, memberAccess.receiverName, position)?.typeName
            ?? typeDeclarationName({ ...input, position }, memberAccess.receiverName);
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
function resolveGuiMemberAccess(input, memberAccess, position) {
    const typeName = memberAccess.receiverName === 'this'
        ? (0, resolution_1.thisReceiverType)({ ...input, position })
        : findDeclarationByName(input, memberAccess.receiverName, position)?.typeName;
    if (typeName === undefined) {
        return undefined;
    }
    return resolveGuiPartPath(input, typeName, memberAccess.memberNames);
}
function findDeclarationMember(input, containerName, memberName) {
    return findDeclarationMemberInHierarchy(input, containerName, memberName, new Set());
}
function findDeclarationMemberInHierarchy(input, containerName, memberName, visitedContainerNames) {
    if (visitedContainerNames.has(containerName)) {
        return undefined;
    }
    visitedContainerNames.add(containerName);
    const member = findDirectDeclarationMember(input, containerName, memberName);
    if (member !== undefined) {
        return member;
    }
    const baseName = findTypeBaseName(input, containerName);
    if (baseName !== undefined) {
        const baseMember = findDeclarationMemberInHierarchy(input, baseName, memberName, visitedContainerNames);
        if (baseMember !== undefined) {
            return baseMember;
        }
    }
    return findRecoveredGuiDeclarationMember(input, containerName, memberName)
        ?? findRecoveredStaticMember(input, containerName, memberName);
}
function findDirectDeclarationMember(input, containerName, memberName) {
    return visibleDeclarations(input, memberName)
        .filter((declaration) => declaration.containerName === containerName)
        .sort(compareDeclarations)[0];
}
function findDeclarationMemberWithoutRecovery(input, containerName, memberName, visitedContainerNames) {
    if (visitedContainerNames.has(containerName)) {
        return undefined;
    }
    visitedContainerNames.add(containerName);
    const member = findDirectDeclarationMember(input, containerName, memberName);
    if (member !== undefined) {
        return member;
    }
    const baseName = findTypeBaseName(input, containerName);
    return baseName === undefined
        ? undefined
        : findDeclarationMemberWithoutRecovery(input, baseName, memberName, visitedContainerNames);
}
function findRecoveredGuiDeclarationMember(input, containerName, memberName) {
    if (!/^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(containerName)) {
        return undefined;
    }
    const declaration = visibleDeclarations(input, memberName)
        .filter((item) => item.containerName === undefined && isRecoveredGuiMember(item, memberName))
        .sort(compareDeclarations)[0];
    return declaration === undefined ? undefined : { ...declaration, containerName };
}
function isRecoveredGuiMember(declaration, memberName) {
    return declaration.detail.includes(`${memberName}(`) || declaration.detail.endsWith(memberName);
}
function findRecoveredStaticMember(input, containerName, memberName) {
    return visibleDeclarations(input, memberName)
        .filter((declaration) => declaration.containerName === undefined)
        .filter((declaration) => declaration.detail.startsWith('static '))
        .filter((declaration) => recoveredStaticMemberOwner(input, containerName, declaration)?.name === containerName)
        .map((declaration) => ({ ...declaration, containerName }))
        .sort(compareDeclarations)[0];
}
function recoveredStaticMemberOwner(input, containerName, member) {
    return visibleDeclarations(input, containerName)
        .filter((declaration) => declaration.kind === 'class' || declaration.kind === 'struct' || declaration.kind === 'union')
        .filter((declaration) => declaration.uri === member.uri)
        .filter((declaration) => positionBefore(declaration.selectionRange.start, member.selectionRange.start))
        .sort((left, right) => comparePositions(right.selectionRange.start, left.selectionRange.start))[0];
}
function findTypeBaseName(input, typeName) {
    return visibleDeclarations(input, typeName)
        .filter((declaration) => declaration.kind === 'class' || declaration.kind === 'struct' || declaration.kind === 'union')
        .sort(compareDeclarations)[0]?.baseName;
}
function typeDeclarationName(input, name) {
    return visibleDeclarations(input, name)
        .find((declaration) => declaration.kind === 'class' || declaration.kind === 'struct' || declaration.kind === 'union')
        ?.name;
}
function visibleDeclarations(input, name) {
    return (0, resolution_1.visibleDeclarationsByName)(input, name);
}
function findLocalDeclaration(analysis, name, position) {
    return (0, resolution_1.findLocalDeclaration)(analysis, name, position);
}
function hoverForDeclaration(declaration) {
    const plainText = declaration.detail === declaration.kind
        ? `${declaration.detail} ${declaration.name}`
        : declaration.detail;
    return hoverFromText(plainText);
}
function hoverForReferenceDeclaration(declaration, reference) {
    return hoverFromText(reference.memberAccess === undefined
        ? hoverTextForDeclaration(declaration)
        : hoverTextForMemberDeclaration(declaration));
}
function hoverTextForDeclaration(declaration) {
    return declaration.detail === declaration.kind
        ? `${declaration.detail} ${declaration.name}`
        : declaration.detail;
}
function hoverTextForMemberDeclaration(declaration) {
    if (declaration.containerName === undefined || declaration.detail.includes('::')) {
        return hoverTextForDeclaration(declaration);
    }
    const memberSignatureText = `${declaration.name}(`;
    if (declaration.detail.includes(memberSignatureText)) {
        return declaration.detail.replace(memberSignatureText, `${declaration.containerName}::${memberSignatureText}`);
    }
    const memberNameText = declaration.name;
    return declaration.detail.endsWith(memberNameText)
        ? `${declaration.detail.slice(0, -memberNameText.length)}${declaration.containerName}::${memberNameText}`
        : hoverTextForDeclaration(declaration);
}
function hoverFromText(plainText, language = 'axel') {
    return {
        markdown: `\`\`\`${language}\n${plainText}\n\`\`\``,
        plainText
    };
}
function findVisibleGuiClass(input, name) {
    return input.analysis.guiClasses.find((guiClass) => guiClass.name === name)
        ?? input.workspaceIndex.findGuiClass?.(input.analysis.uri, name);
}
function findGuiPartForDeclaration(guiClasses, declaration) {
    for (const guiClass of guiClasses) {
        const part = findPartInClass(guiClass, (candidate) => (candidate.name === declaration.name && sameRange(candidate.range, declaration.range)));
        if (part !== undefined) {
            return { ownerName: guiClass.name, part };
        }
    }
    return undefined;
}
function findGuiMethodForDeclaration(analysis, declaration) {
    return allGuiMethods(analysis)
        .find((method) => method.name === declaration.name && sameRange(method.range, declaration.range));
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
        if (context !== undefined && contains(method.range, input.position)) {
            return context;
        }
    }
    return undefined;
}
function findEnclosingGuiMethodContextInClass(input, guiClass) {
    const classMethod = guiClass.methods.find((method) => contains(method.range, input.position));
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
        const method = part.methods.find((candidate) => contains(candidate.range, position));
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
function isResolvableGuiMethod(input, method) {
    if (!method.event || method.receiverPath.length <= 2) {
        return true;
    }
    const rootName = method.receiverPath[0];
    const partPath = method.receiverPath.slice(1, -1);
    return resolveGuiPartPath(input, rootName, partPath) !== undefined;
}
function resolveGuiPartPath(input, rootClassName, path) {
    let owner = findVisibleGuiClass(input, rootClassName);
    let ownerPath = [];
    let resolved;
    const rootOwner = owner;
    if (rootOwner !== undefined) {
        const directPart = findPartByPath(rootOwner.parts, path);
        if (directPart !== undefined) {
            return { ownerName: rootOwner.name, part: directPart };
        }
    }
    for (const segment of path) {
        if (owner === undefined) {
            return undefined;
        }
        const nextPath = [...ownerPath, segment];
        const part = findPartByPath(owner.parts, nextPath) ?? findPartByPath(owner.parts, [segment]);
        if (part === undefined) {
            return undefined;
        }
        resolved = { ownerName: owner.name, part };
        const partClass = findVisibleGuiClass(input, part.typeName);
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
function findPartByPath(parts, path) {
    return findPart(parts, (part) => sameStringArray(part.path, path));
}
function findPartInClass(guiClass, predicate) {
    return findPart(guiClass.parts, predicate);
}
function findPart(parts, predicate) {
    for (const part of parts) {
        if (predicate(part)) {
            return part;
        }
        const child = findPart(part.parts, predicate);
        if (child !== undefined) {
            return child;
        }
    }
    return undefined;
}
function guiPartText(ownerName, part) {
    return `${part.typeName} ${ownerName}::${part.path.join('.')}`;
}
function implicitGuiPartText(rootClassName, part) {
    return guiPartText(rootClassName, part);
}
function guiClassText(guiClass) {
    return `class ${guiClass.name} : public ${guiClass.baseName}`;
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
function allGuiMethods(analysis) {
    return [
        ...analysis.guiMethods,
        ...analysis.guiClasses.flatMap((guiClass) => guiClass.methods)
    ];
}
function segmentIndexAtPosition(method, position) {
    const segmentIndex = method.receiverPathSegmentRanges
        ?.findIndex((range) => contains(range, position));
    return segmentIndex === undefined || segmentIndex < 0 ? undefined : segmentIndex;
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
//# sourceMappingURL=hover.js.map