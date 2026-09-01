"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectSemanticDiagnostics = collectSemanticDiagnostics;
const builtins_1 = require("./builtins");
const guiClassKinds_1 = require("./guiClassKinds");
const resolution_1 = require("./resolution");
function collectSemanticDiagnostics(input) {
    const workspaceIndex = input.workspaceIndex === undefined
        ? undefined
        : createCachedWorkspaceIndex(input.analysis.uri, input.workspaceIndex);
    return [
        ...duplicateDeclarationDiagnostics(input.analysis),
        ...unresolvedTypeReferenceDiagnostics(input.analysis, workspaceIndex),
        ...unresolvedIdentifierDiagnostics(input.analysis, workspaceIndex),
        ...guiReceiverPathDiagnostics(input.analysis, workspaceIndex),
        ...doModalOnCreateDiagnostics(input.analysis)
    ];
}
function createCachedWorkspaceIndex(sourceUri, workspaceIndex) {
    let visibleDeclarations;
    const declarationsByName = new Map();
    const declarationLookupCache = new Map();
    const guiClassLookupCache = new Map();
    function listVisibleDeclarations(uri) {
        if (uri !== sourceUri) {
            return workspaceIndex.listVisibleDeclarations?.(uri) ?? [];
        }
        visibleDeclarations ??= workspaceIndex.listVisibleDeclarations?.(sourceUri) ?? [];
        return visibleDeclarations;
    }
    return {
        findVisibleGuiClasses: (uri, name) => {
            const key = `${uri}\0${name}`;
            const cached = guiClassLookupCache.get(key);
            if (cached !== undefined) {
                return cached;
            }
            const classes = workspaceIndex.findVisibleGuiClasses?.(uri, name) ?? [];
            guiClassLookupCache.set(key, classes);
            return classes;
        },
        findVisibleDeclarations: (uri, name) => {
            if (uri === sourceUri && workspaceIndex.listVisibleDeclarations !== undefined) {
                const cached = declarationsByName.get(name);
                if (cached !== undefined) {
                    return cached;
                }
                const declarations = listVisibleDeclarations(uri).filter((declaration) => declaration.name === name);
                declarationsByName.set(name, declarations);
                return declarations;
            }
            const key = `${uri}\0${name}`;
            const cached = declarationLookupCache.get(key);
            if (cached !== undefined) {
                return cached;
            }
            const declarations = workspaceIndex.findVisibleDeclarations?.(uri, name) ?? [];
            declarationLookupCache.set(key, declarations);
            return declarations;
        },
        listVisibleDeclarations
    };
}
function duplicateDeclarationDiagnostics(analysis) {
    const declarations = new Map(analysis.declarations.map((declaration) => [declaration.id, declaration]));
    const diagnostics = [];
    for (const scope of analysis.scopes) {
        diagnostics.push(...duplicateDeclarationDiagnosticsForScope(scope, declarations));
    }
    return diagnostics;
}
function duplicateDeclarationDiagnosticsForScope(scope, declarations) {
    const seen = new Map();
    const diagnostics = [];
    for (const declarationId of scope.declarationIds) {
        const declaration = declarations.get(declarationId);
        if (declaration === undefined || !isDuplicateCheckedDeclaration(declaration)) {
            continue;
        }
        if (seen.has(declaration.name)) {
            diagnostics.push({
                severity: 'error',
                source: 'axel',
                message: `Duplicate declaration '${declaration.name}'.`,
                range: declaration.selectionRange
            });
            continue;
        }
        seen.set(declaration.name, declaration);
    }
    return diagnostics;
}
function isDuplicateCheckedDeclaration(declaration) {
    return declaration.name !== ''
        && declaration.kind !== 'include'
        && declaration.kind !== 'macro'
        && declaration.kind !== 'function'
        && declaration.kind !== 'parameter'
        && !isFunctionPrototypeDeclaration(declaration)
        && !isMacroPrefixedBuiltinCallRecovery(declaration);
}
function isFunctionPrototypeDeclaration(declaration) {
    return declaration.kind === 'variable' && declaration.detail.includes('(');
}
function isMacroPrefixedBuiltinCallRecovery(declaration) {
    return declaration.kind === 'variable'
        && (0, builtins_1.getBuiltinHover)(declaration.name) !== null
        && /^[A-Z_$][0-9A-Z_$]*\s+[0-9A-Za-z_$]+$/.test(declaration.detail);
}
const BUILTIN_TYPE_NAMES = new Set([
    'bool',
    'char',
    'short',
    'int',
    'long',
    'float',
    'double',
    'void',
    'string',
    'natural',
    'ipoint',
    'izone',
    'icoord'
]);
const TYPE_DECLARATION_KINDS = new Set([
    'typedef',
    'class',
    'struct',
    'union',
    'enum'
]);
function unresolvedTypeReferenceDiagnostics(analysis, workspaceIndex) {
    if (hasSyntaxDiagnostics(analysis.diagnostics)) {
        return [];
    }
    return analysis.references
        .filter((reference) => reference.typeReference === true)
        .filter((reference) => !isMacroLikeTypeRecovery(reference.name))
        .filter((reference) => !isKnownTypeReference(reference.name, analysis, workspaceIndex))
        .map((reference) => ({
        severity: 'error',
        source: 'axel',
        message: `Unknown type '${reference.name}'.`,
        range: reference.range
    }));
}
function isKnownTypeReference(name, analysis, workspaceIndex) {
    if (BUILTIN_TYPE_NAMES.has(name) || (0, guiClassKinds_1.isGuiPartTypeName)(name)) {
        return true;
    }
    const declarations = [
        ...analysis.declarations.filter((declaration) => declaration.name === name),
        ...(workspaceIndex?.findVisibleDeclarations?.(analysis.uri, name) ?? [])
    ];
    return declarations.some((declaration) => TYPE_DECLARATION_KINDS.has(declaration.kind));
}
function isMacroLikeTypeRecovery(name) {
    return /^[A-Z_$][0-9A-Z_$]*$/.test(name);
}
const KNOWN_VALUE_NAMES = new Set([
    'FALSE',
    'NULL',
    'TRUE',
    'nullptr'
]);
function unresolvedIdentifierDiagnostics(analysis, workspaceIndex) {
    if (hasSyntaxDiagnostics(analysis.diagnostics)) {
        return [];
    }
    return analysis.references
        .filter((reference) => reference.typeReference !== true)
        .filter((reference) => !isKnownIdentifierReference(reference, analysis, workspaceIndex))
        .map((reference) => ({
        severity: 'error',
        source: 'axel',
        message: `Unknown identifier '${reference.name}'.`,
        range: reference.range
    }));
}
function isKnownIdentifierReference(reference, analysis, workspaceIndex) {
    if (KNOWN_VALUE_NAMES.has(reference.name)
        || BUILTIN_TYPE_NAMES.has(reference.name)
        || (0, guiClassKinds_1.isGuiPartTypeName)(reference.name)
        || (0, builtins_1.getBuiltinHover)(reference.name) !== null
        || isMacroLikeTypeRecovery(reference.name)) {
        return true;
    }
    if (isKnownDirectGuiDialogCall(reference, analysis)) {
        return true;
    }
    if (reference.memberAccess !== undefined) {
        return isKnownMemberReference(reference, analysis, workspaceIndex);
    }
    const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
    if ((0, resolution_1.findLocalDeclaration)(analysis, reference.name, reference.range.start) !== undefined) {
        return true;
    }
    if ((0, resolution_1.visibleDeclarationsByName)(input, reference.name).length > 0) {
        return true;
    }
    return isKnownImplicitGuiReference(reference, analysis, workspaceIndex);
}
function isKnownMemberReference(reference, analysis, workspaceIndex) {
    const memberAccess = reference.memberAccess;
    if (memberAccess === undefined) {
        return true;
    }
    const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
    const receiverType = memberAccess.receiverName === 'this'
        ? (0, resolution_1.thisReceiverType)(input)
        : (0, resolution_1.receiverTypeName)(input, memberAccess.receiverName)
            ?? typeDeclarationName(input, memberAccess.receiverName);
    if (receiverType === undefined) {
        return true;
    }
    const parentMembers = memberAccess.memberNames.slice(0, -1);
    const ownerType = parentMembers.length === 0
        ? receiverType
        : (0, resolution_1.resolveMemberAccessType)(input, receiverType, parentMembers);
    if (ownerType === undefined || (0, guiClassKinds_1.isGuiPartTypeName)(ownerType)) {
        return true;
    }
    return (0, resolution_1.findDeclarationMember)(input, ownerType, reference.name) !== undefined;
}
function isKnownDirectGuiDialogCall(reference, analysis) {
    return reference.call === true
        && (reference.name === 'DoModal' || reference.name === 'DoModless')
        && findEnclosingGuiMethodContext(analysis, undefined, reference.range.start)?.rootClassName !== undefined;
}
function typeDeclarationName(input, name) {
    const declaration = (0, resolution_1.visibleDeclarationsByName)(input, name).find(resolution_1.isTypeDeclaration);
    return declaration?.name;
}
function isKnownImplicitGuiReference(reference, analysis, workspaceIndex) {
    const context = findEnclosingGuiMethodContext(analysis, workspaceIndex, reference.range.start);
    if (context === undefined) {
        return false;
    }
    const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
    return findGuiPartByName(analysis, workspaceIndex, context.rootClassName, reference.name) !== undefined
        || (0, resolution_1.findDeclarationMember)(input, context.receiverTypeName, reference.name) !== undefined
        || (0, resolution_1.findDeclarationMember)(input, context.rootClassName, reference.name) !== undefined
        || (0, guiClassKinds_1.isGuiPartTypeName)(context.receiverTypeName);
}
function findEnclosingGuiMethodContext(analysis, workspaceIndex, position) {
    for (const guiClass of analysis.guiClasses) {
        const classMethod = guiClass.methods.find((method) => containsRange(method.range, { start: position, end: position }));
        if (classMethod !== undefined) {
            return { rootClassName: guiClass.name, receiverTypeName: guiClass.name };
        }
        const partMethod = findEnclosingGuiPartMethod(guiClass.parts, position);
        if (partMethod !== undefined) {
            return { rootClassName: guiClass.name, receiverTypeName: partMethod.typeName };
        }
    }
    const classResolver = createGuiClassResolver(analysis, workspaceIndex);
    for (const method of analysis.guiMethods) {
        if (!containsRange(method.range, { start: position, end: position })) {
            continue;
        }
        const rootClassName = method.receiverPath[0];
        if (rootClassName === undefined) {
            continue;
        }
        const rootClass = classResolver.find(rootClassName);
        const part = rootClass === undefined
            ? undefined
            : resolveGuiPartPath(rootClass, classResolver, method.receiverPath.slice(1, -1));
        return {
            rootClassName,
            receiverTypeName: part?.typeName ?? rootClassName
        };
    }
    return undefined;
}
function findEnclosingGuiPartMethod(parts, position) {
    for (const part of parts) {
        if (part.methods.some((method) => containsRange(method.range, { start: position, end: position }))) {
            return part;
        }
        const child = findEnclosingGuiPartMethod(part.parts, position);
        if (child !== undefined) {
            return child;
        }
    }
    return undefined;
}
function findGuiPartByName(analysis, workspaceIndex, rootClassName, name) {
    const rootClass = createGuiClassResolver(analysis, workspaceIndex).find(rootClassName);
    return rootClass === undefined ? undefined : findPart(rootClass.parts, (part) => part.name === name);
}
function guiReceiverPathDiagnostics(analysis, workspaceIndex) {
    if (hasSyntaxDiagnostics(analysis.diagnostics)) {
        return [];
    }
    const classResolver = createGuiClassResolver(analysis, workspaceIndex);
    const diagnostics = [];
    for (const method of analysis.guiMethods) {
        const diagnostic = guiReceiverPathDiagnostic(method, classResolver);
        if (diagnostic !== undefined) {
            diagnostics.push(diagnostic);
        }
    }
    return diagnostics;
}
function guiReceiverPathDiagnostic(method, classResolver) {
    if (!method.event || method.receiverPath.length < 3 || method.receiverPathSegmentRanges === undefined) {
        return undefined;
    }
    const rootClass = classResolver.find(method.receiverPath[0]);
    if (rootClass === undefined) {
        return undefined;
    }
    for (let index = 1; index < method.receiverPath.length - 1; index += 1) {
        const path = method.receiverPath.slice(1, index + 1);
        if (resolveGuiPartPath(rootClass, classResolver, path) === undefined) {
            const segment = method.receiverPath[index];
            return {
                severity: 'error',
                source: 'axel',
                message: `Unknown GUI receiver path segment '${segment}'.`,
                range: method.receiverPathSegmentRanges[index]
            };
        }
    }
    return undefined;
}
function resolveGuiPartPath(rootClass, classResolver, path) {
    let owner = rootClass;
    let ownerPath = [];
    let resolved;
    const directPart = findPartByPath(rootClass.parts, path);
    if (directPart !== undefined) {
        return directPart;
    }
    for (const segment of path) {
        if (owner === undefined) {
            return undefined;
        }
        const nextPath = [...ownerPath, segment];
        const part = findPartByPath(owner.parts, nextPath)
            ?? findPartByPath(owner.parts, [segment]);
        if (part === undefined) {
            return undefined;
        }
        resolved = part;
        const partClass = classResolver.find(part.typeName);
        owner = partClass ?? owner;
        ownerPath = partClass === undefined ? nextPath : [];
    }
    return resolved;
}
function createGuiClassResolver(analysis, workspaceIndex) {
    const localClasses = new Map(analysis.guiClasses.map((guiClass) => [guiClass.name, guiClass]));
    return {
        find: (name) => {
            const visibleClasses = workspaceIndex?.findVisibleGuiClasses?.(analysis.uri, name);
            if (visibleClasses !== undefined) {
                return visibleClasses.length === 1 ? visibleClasses[0] : undefined;
            }
            return localClasses.get(name);
        }
    };
}
function hasSyntaxDiagnostics(diagnostics) {
    return diagnostics.some((diagnostic) => (diagnostic.severity === 'error'
        && (diagnostic.message === 'Syntax error.' || diagnostic.message.startsWith('Missing '))));
}
function findPartByPath(parts, path) {
    return findPart(parts, (part) => sameStringArray(part.path, path));
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
function sameStringArray(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}
function doModalOnCreateDiagnostics(analysis) {
    const dialogClassNames = new Set(analysis.guiClasses
        .filter((guiClass) => guiClass.kind === 'dialog')
        .map((guiClass) => guiClass.name));
    const onCreateMethods = allGuiMethods(analysis.guiClasses, analysis.guiMethods)
        .filter((method) => method.name === 'OnCreate' && dialogClassNames.has(method.receiverPath[0]));
    return analysis.references
        .filter((reference) => reference.name === 'DoModal' && reference.call === true)
        .filter((reference) => onCreateMethods.some((method) => containsRange(method.range, reference.range)))
        .map((reference) => ({
        severity: 'warning',
        source: 'axel',
        message: 'DoModal should not be called inside a GCDialog OnCreate handler.',
        range: reference.range
    }));
}
function allGuiMethods(guiClasses, externalMethods) {
    return [
        ...externalMethods,
        ...guiClasses.flatMap((guiClass) => [
            ...guiClass.methods,
            ...guiPartMethods(guiClass.parts)
        ])
    ];
}
function guiPartMethods(parts) {
    return parts.flatMap((part) => [
        ...part.methods,
        ...guiPartMethods(part.parts)
    ]);
}
function containsRange(container, range) {
    return positionBeforeOrEqual(container.start, range.start) && positionBeforeOrEqual(range.end, container.end);
}
function positionBeforeOrEqual(left, right) {
    return left.line < right.line || (left.line === right.line && left.character <= right.character);
}
//# sourceMappingURL=semanticDiagnostics.js.map