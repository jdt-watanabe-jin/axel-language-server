"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectSemanticTokens = collectSemanticTokens;
const resolution_1 = require("./resolution");
function collectSemanticTokens(analysis, workspaceIndex = {}) {
    const tokens = [
        ...analysis.declarations.flatMap(tokenFromDeclaration),
        ...analysis.references.flatMap((reference) => tokenFromReference(reference, analysis, workspaceIndex)),
        ...analysis.scriptExecutions.map((execution) => ({
            range: execution.selectionRange,
            tokenType: 'function',
            modifiers: []
        })),
        ...guiReceiverPathTokens(analysis),
        ...guiMethodDeclarationTokens(analysis)
    ];
    return dedupeAndSort(tokens).filter(isSingleLineToken);
}
function tokenFromDeclaration(declaration) {
    const tokenType = tokenTypeFromDeclaration(declaration);
    if (tokenType === undefined) {
        return [];
    }
    return [{
            range: declaration.selectionRange,
            tokenType,
            modifiers: ['declaration']
        }];
}
function tokenFromReference(reference, analysis, workspaceIndex) {
    if (isGuiMethodSelectionReference(analysis, reference)) {
        return [];
    }
    const tokenType = tokenTypeFromReference(reference, analysis, workspaceIndex);
    if (tokenType === undefined) {
        return [];
    }
    return [{
            range: reference.range,
            tokenType,
            modifiers: []
        }];
}
function tokenTypeFromDeclaration(declaration) {
    switch (declaration.kind) {
        case 'class':
            return 'class';
        case 'enum':
            return 'enum';
        case 'enumMember':
            return 'enumMember';
        case 'field':
            return 'property';
        case 'function':
            return 'function';
        case 'macro':
            return 'macro';
        case 'method':
            return 'method';
        case 'parameter':
            return 'parameter';
        case 'struct':
        case 'union':
            return 'struct';
        case 'typedef':
            return 'type';
        case 'variable':
            return 'variable';
        case 'include':
            return undefined;
    }
}
function tokenTypeFromReference(reference, analysis, workspaceIndex) {
    if (reference.memberAccess !== undefined) {
        return reference.call === true ? 'method' : 'property';
    }
    const localDeclaration = (0, resolution_1.findLocalDeclaration)(analysis, reference.name, reference.range.start);
    if (localDeclaration !== undefined && referenceMatchesDeclarationKind(reference, localDeclaration)) {
        return tokenTypeFromReferenceDeclaration(reference, localDeclaration);
    }
    const resolutionInput = { analysis, workspaceIndex, position: reference.range.start };
    const implicitGuiMember = findImplicitGuiMemberDeclaration(resolutionInput, reference);
    if (implicitGuiMember !== undefined) {
        return tokenTypeFromReferenceDeclaration(reference, implicitGuiMember);
    }
    const visibleDeclaration = matchingVisibleDeclaration(reference, resolutionInput);
    if (visibleDeclaration !== undefined) {
        return tokenTypeFromReferenceDeclaration(reference, visibleDeclaration);
    }
    return undefined;
}
function matchingVisibleDeclaration(reference, input) {
    return (0, resolution_1.visibleDeclarationsByName)(input, reference.name)
        .find((declaration) => referenceMatchesDeclarationKind(reference, declaration));
}
function referenceMatchesDeclarationKind(reference, declaration) {
    if (reference.call === true) {
        return declaration.kind === 'function'
            || declaration.kind === 'method'
            || declaration.kind === 'macro'
            || isFunctionLikeVariableDeclaration(reference, declaration);
    }
    if (reference.typeReference === true) {
        return ['class', 'struct', 'union', 'enum', 'typedef'].includes(declaration.kind);
    }
    return true;
}
function tokenTypeFromReferenceDeclaration(reference, declaration) {
    if (isFunctionLikeVariableDeclaration(reference, declaration)) {
        return declaration.containerName === undefined ? 'function' : 'method';
    }
    return tokenTypeFromDeclaration(declaration);
}
function isFunctionLikeVariableDeclaration(reference, declaration) {
    return reference.call === true
        && declaration.kind === 'variable'
        && declaration.detail.includes(`${declaration.name}(`);
}
function findImplicitGuiMemberDeclaration(input, reference) {
    const context = findEnclosingGuiMethodContext(input.analysis, reference.range.start);
    if (context === undefined) {
        return undefined;
    }
    return (0, resolution_1.findDeclarationMember)(input, context.receiverTypeName, reference.name)
        ?? findRecoveredGuiDeclarationMember(input, context.receiverTypeName, reference)
        ?? (0, resolution_1.findDeclarationMember)(input, context.rootClassName, reference.name)
        ?? findRecoveredGuiDeclarationMember(input, context.rootClassName, reference);
}
function findEnclosingGuiMethodContext(analysis, position) {
    for (const guiClass of analysis.guiClasses) {
        const context = findEnclosingGuiMethodContextInClass(guiClass, position);
        if (context !== undefined) {
            return context;
        }
    }
    for (const method of analysis.guiMethods) {
        const context = guiMethodContextFromReceiverPath(analysis.guiClasses, method);
        if (context !== undefined && (0, resolution_1.contains)(method.range, position)) {
            return context;
        }
    }
    return undefined;
}
function findEnclosingGuiMethodContextInClass(guiClass, position) {
    const classMethod = guiClass.methods.find((method) => (0, resolution_1.contains)(method.range, position));
    if (classMethod !== undefined) {
        return guiMethodContextFromReceiverPath([guiClass], classMethod)
            ?? { rootClassName: guiClass.name, receiverTypeName: guiClass.name };
    }
    const partMethod = findEnclosingGuiPartMethod(guiClass.parts, position);
    return partMethod === undefined
        ? undefined
        : { rootClassName: guiClass.name, receiverTypeName: partMethod.part.typeName };
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
function guiMethodContextFromReceiverPath(guiClasses, method) {
    const rootClassName = method.receiverPath[0];
    if (rootClassName === undefined) {
        return undefined;
    }
    const partPath = method.receiverPath.slice(1, -1);
    if (partPath.length === 0) {
        return { rootClassName, receiverTypeName: rootClassName };
    }
    const part = resolveGuiPartPath(guiClasses, rootClassName, partPath);
    return part === undefined ? undefined : { rootClassName, receiverTypeName: part.typeName };
}
function resolveGuiPartPath(guiClasses, rootClassName, path) {
    const guiClass = guiClasses.find((candidate) => candidate.name === rootClassName);
    return guiClass === undefined ? undefined : findPartByPath(guiClass.parts, path);
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
function sameStringArray(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}
function findRecoveredGuiDeclarationMember(input, containerName, reference) {
    if (!/^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(containerName)) {
        return undefined;
    }
    const declaration = (0, resolution_1.visibleDeclarationsByName)(input, reference.name)
        .filter((item) => item.containerName === undefined && isRecoveredGuiMember(item, reference.name))
        .sort(resolution_1.compareDeclarations)[0];
    if (declaration === undefined) {
        return undefined;
    }
    return {
        ...declaration,
        containerName,
        kind: reference.call === true ? 'method' : 'field'
    };
}
function isRecoveredGuiMember(declaration, memberName) {
    return declaration.detail.includes(`${memberName}(`) || declaration.detail.endsWith(memberName);
}
function isGuiMethodSelectionReference(analysis, reference) {
    return allGuiMethods(analysis).some((method) => (method.name === reference.name
        && method.selectionRange !== undefined
        && sameRange(method.selectionRange, reference.range)));
}
function guiReceiverPathTokens(analysis) {
    return allGuiMethods(analysis)
        .flatMap(tokenFromGuiReceiverPath);
}
function guiMethodDeclarationTokens(analysis) {
    return allGuiMethods(analysis)
        .flatMap(tokenFromGuiMethodDeclaration);
}
function tokenFromGuiMethodDeclaration(method) {
    if (method.selectionRange === undefined || method.receiverPathSegmentRanges !== undefined) {
        return [];
    }
    return [{
            range: method.selectionRange,
            tokenType: 'method',
            modifiers: ['declaration']
        }];
}
function tokenFromGuiReceiverPath(method) {
    const ranges = method.receiverPathSegmentRanges;
    if (ranges === undefined || ranges.length !== method.receiverPath.length || ranges.length < 2) {
        return [];
    }
    return ranges.map((range, index) => ({
        range,
        tokenType: guiReceiverPathSegmentTokenType(index, ranges.length),
        modifiers: index === ranges.length - 1 ? ['declaration'] : []
    }));
}
function guiReceiverPathSegmentTokenType(index, segmentCount) {
    if (index === 0) {
        return 'class';
    }
    return index === segmentCount - 1 ? 'function' : 'variable';
}
function allGuiMethods(analysis) {
    return [
        ...analysis.guiMethods,
        ...analysis.guiClasses.flatMap((guiClass) => [
            ...guiClass.methods,
            ...guiClass.parts.flatMap(methodsFromGuiPart)
        ])
    ];
}
function methodsFromGuiPart(part) {
    return [
        ...part.methods,
        ...part.parts.flatMap(methodsFromGuiPart)
    ];
}
function sameRange(left, right) {
    return left.start.line === right.start.line
        && left.start.character === right.start.character
        && left.end.line === right.end.line
        && left.end.character === right.end.character;
}
function dedupeAndSort(tokens) {
    const seen = new Set();
    return [...tokens]
        .sort(compareTokens)
        .filter((token) => {
        const key = tokenKey(token);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function compareTokens(left, right) {
    return left.range.start.line - right.range.start.line
        || left.range.start.character - right.range.start.character
        || tokenLength(left) - tokenLength(right)
        || left.tokenType.localeCompare(right.tokenType);
}
function isSingleLineToken(token) {
    return token.range.start.line === token.range.end.line && tokenLength(token) > 0;
}
function tokenLength(token) {
    return token.range.end.character - token.range.start.character;
}
function tokenKey(token) {
    return [
        token.range.start.line,
        token.range.start.character,
        token.range.end.line,
        token.range.end.character,
        token.tokenType
    ].join(':');
}
//# sourceMappingURL=semanticTokens.js.map