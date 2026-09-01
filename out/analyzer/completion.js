"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCompletions = getCompletions;
const builtins_1 = require("./builtins");
const guiClassKinds_1 = require("./guiClassKinds");
const resolution_1 = require("./resolution");
const DECLARATION_KEYWORDS = [
    '#include',
    '#define',
    'class',
    'struct',
    'union',
    'enum',
    'typedef',
    'public',
    'private',
    'protected',
    'static',
    'extern',
    'global',
    'universal',
    'virtual',
    'const'
];
const EXPRESSION_KEYWORDS = [
    'if',
    'else',
    'switch',
    'case',
    'default',
    'do',
    'while',
    'for',
    'return',
    'break',
    'continue',
    'goto',
    'throw',
    'try',
    'catch',
    'sizeof',
    'new',
    'delete',
    'this',
    'TRUE',
    'FALSE',
    'NULL',
    'nullptr'
];
const BUILTIN_TYPE_NAMES = [
    'char',
    'short',
    'int',
    'long',
    'float',
    'double',
    'void',
    'string'
];
const COMMON_GUI_EVENTS = [
    'OnCreate'
];
const DIALOG_GUI_EVENTS = [
    'OnOK',
    'OnCancel',
    'OnApply'
];
const LIST_VIEW_GUI_EVENTS = [
    'OnChanged',
    'OnClicked',
    'OnDoubleClicked',
    'OnPressed',
    'OnReturnPressed',
    'OnSpacePressed',
    'OnCollapsed',
    'OnExpanded',
    'OnRightButtonPressed',
    'OnSelectionChanged'
];
const TABLE_VIEW_GUI_EVENTS = [
    'OnCurrentChanged',
    'OnDoubleClicked',
    'OnPressed',
    'OnSelectionChanged',
    'OnValueChanged'
];
const SLIDER_GUI_EVENTS = [
    'OnChanged',
    'OnPressed',
    'OnReleased'
];
const BUTTON_GUI_EVENTS = [
    'OnPush',
    'OnChanged',
    'OnSelected',
    'OnClicked'
];
function getCompletions(input) {
    const context = classifyCompletionContext(input.text, input.position);
    if (context.kind === 'include') {
        return includePathCompletions(input, context);
    }
    if (context.kind === 'scriptExecution') {
        return scriptExecutionPathCompletions(input, context);
    }
    if (context.kind === 'member') {
        return memberCompletions(input, context);
    }
    if (context.kind === 'guiReceiver') {
        return guiReceiverCompletions(input, context);
    }
    const items = [];
    if (context.kind === 'topLevel') {
        items.push(...declarationKeywordItems(context.typedHash));
        items.push(...typeCompletionItems(input));
    }
    if (context.kind === 'expression') {
        items.push(...keywordItems(EXPRESSION_KEYWORDS));
        items.push(...(0, builtins_1.getBuiltinCompletions)());
        items.push(...visibleDeclarationCompletions(input, (declaration) => !isTypeDeclaration(declaration)));
        items.push(...implicitGuiContextCompletions(input));
    }
    if (context.kind === 'type') {
        items.push(...typeCompletionItems(input));
    }
    return uniqueCompletions(items);
}
function classifyCompletionContext(text, position) {
    const offset = offsetFromPosition(text, position);
    const before = text.slice(0, offset);
    const linePrefix = before.slice(before.lastIndexOf('\n') + 1);
    const include = includeContext(linePrefix);
    if (include !== undefined) {
        return include;
    }
    const scriptExecution = scriptExecutionContext(linePrefix);
    if (scriptExecution !== undefined) {
        return scriptExecution;
    }
    const receiver = receiverContext(linePrefix);
    if (receiver !== undefined) {
        return receiver;
    }
    if (isInheritanceTypeContext(linePrefix)) {
        return { kind: 'type' };
    }
    if (isLikelyTypeContext(text, offset)) {
        return { kind: 'type' };
    }
    return isTopLevelPosition(text, offset) ? { kind: 'topLevel', typedHash: isHashOnlyLinePrefix(linePrefix) } : { kind: 'expression' };
}
function isHashOnlyLinePrefix(linePrefix) {
    return /^\s*#$/.test(linePrefix);
}
function includeContext(linePrefix) {
    const quoted = linePrefix.match(/^\s*#\s*(?:include|using)\s+L?"([^"\n]*)$/);
    if (quoted !== null) {
        return { kind: 'include', prefix: quoted[1], includeKind: 'quote' };
    }
    const angled = linePrefix.match(/^\s*#\s*(?:include|using)\s+<([^>\n]*)$/);
    return angled === null ? undefined : { kind: 'include', prefix: angled[1], includeKind: 'angle' };
}
function receiverContext(linePrefix) {
    const match = linePrefix.match(/([A-Za-z_$][0-9A-Za-z_$]*(?:(?:::|\.|->)[A-Za-z_$][0-9A-Za-z_$]*)*)(?:::|\.|->)[A-Za-z_$0-9]*$/);
    if (match === null) {
        return undefined;
    }
    const text = match[1];
    const fullMatch = match[0];
    const parts = text.split(/::|\.|->/).filter((part) => part.length > 0);
    const rootName = parts[0];
    if (rootName === undefined) {
        return undefined;
    }
    return fullMatch.includes('::')
        ? { kind: 'guiReceiver', rootName, path: parts.slice(1) }
        : { kind: 'member', receiverName: rootName, path: parts.slice(1) };
}
function isInheritanceTypeContext(linePrefix) {
    return /:\s*(?:(?:public|private|protected)\s*)?$/.test(linePrefix);
}
function isLikelyTypeContext(text, offset) {
    const before = text.slice(0, offset);
    const after = text.slice(offset);
    const prefix = before.match(/(?:^|[;{}\n])\s*([A-Za-z_$][0-9A-Za-z_$]*\s+)*$/);
    const suffix = after.match(/^\s*[A-Za-z_$][0-9A-Za-z_$]*\s*(?:[;=({,*&[]|$)/);
    return prefix !== null && suffix !== null;
}
function isTopLevelPosition(text, offset) {
    let depth = 0;
    for (const char of text.slice(0, offset)) {
        if (char === '{') {
            depth += 1;
        }
        else if (char === '}') {
            depth = Math.max(0, depth - 1);
        }
    }
    return depth === 0;
}
function includePathCompletions(input, context) {
    return (input.workspaceIndex.findIncludePathCompletions?.(input.analysis.uri, context.prefix, context.includeKind) ?? [])
        .map((candidate) => includeCompletionFromPath(candidate));
}
function scriptExecutionContext(linePrefix) {
    const match = linePrefix.match(/(?:^|[;{]\s*)@([^\s;`]*)$/);
    return match === null ? undefined : { kind: 'scriptExecution', prefix: match[1] };
}
function includeCompletionFromPath(candidate) {
    const name = includePathSegment(candidate);
    const parentPath = candidate.slice(0, candidate.length - name.length);
    return {
        name,
        kind: 'include',
        detail: parentPath.length === 0 ? 'include path' : `include path: ${parentPath}`,
        insertText: name,
        filterText: candidate,
        sortText: candidate
    };
}
function scriptExecutionPathCompletions(input, context) {
    return (input.workspaceIndex.findScriptExecutionPathCompletions?.(input.analysis.uri, context.prefix) ?? [])
        .map((candidate) => scriptExecutionCompletionFromPath(candidate));
}
function scriptExecutionCompletionFromPath(candidate) {
    const name = includePathSegment(candidate);
    const parentPath = candidate.slice(0, candidate.length - name.length);
    return {
        name,
        kind: 'function',
        detail: parentPath.length === 0 ? 'AXEL execution file' : `AXEL execution path: ${parentPath}`,
        insertText: name,
        filterText: candidate,
        sortText: candidate
    };
}
function includePathSegment(candidate) {
    const trimmed = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
    const slashIndex = trimmed.lastIndexOf('/');
    return slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);
}
function memberCompletions(input, context) {
    const implicit = implicitGuiMemberCompletions(input, [context.receiverName, ...context.path]);
    if (implicit.length > 0) {
        return uniqueCompletions(implicit);
    }
    const rootTypeName = context.receiverName === 'this'
        ? thisReceiverType(input)
        : receiverTypeName(input, context.receiverName);
    if (rootTypeName === undefined) {
        return [];
    }
    const receiverType = resolveMemberAccessType(input, rootTypeName, context.path);
    if (receiverType === undefined) {
        return [];
    }
    const guiClass = findVisibleGuiClass(input, receiverType);
    return uniqueCompletions([
        ...typeMemberCompletions(input, receiverType),
        ...guiPartChildCompletions(guiClass?.parts ?? [])
    ]);
}
function guiReceiverCompletions(input, context) {
    const root = findVisibleGuiClass(input, context.rootName);
    if (root === undefined) {
        return staticTypeMemberCompletions(input, context);
    }
    const part = context.path.length === 0 ? undefined : resolveGuiPartPath(input, context.rootName, context.path);
    const receiverTypeName = part?.part.typeName ?? root.name;
    return uniqueCompletions([
        ...guiPartChildCompletions(part?.part.parts ?? root.parts),
        ...typeMemberCompletions(input, receiverTypeName),
        ...guiEventCompletions(root.kind === 'dialog' && context.path.length === 0 ? 'GCDialog' : receiverTypeName)
    ]);
}
function staticTypeMemberCompletions(input, context) {
    const rootTypeName = typeDeclarationName(input, context.rootName);
    if (rootTypeName === undefined) {
        return [];
    }
    const receiverType = context.path.length === 0
        ? rootTypeName
        : resolveMemberAccessType(input, rootTypeName, context.path);
    return receiverType === undefined ? [] : uniqueCompletions(typeMemberCompletions(input, receiverType));
}
function implicitGuiContextCompletions(input) {
    const context = findEnclosingGuiMethodContext(input);
    if (context === undefined) {
        return [];
    }
    const root = findVisibleGuiClass(input, context.rootClassName);
    return uniqueCompletions([
        ...visibleDeclarationCompletions(input, (declaration) => !isTypeDeclaration(declaration)),
        ...guiPartChildCompletions(root?.parts ?? []),
        ...typeMemberCompletions(input, context.rootClassName),
        ...typeMemberCompletions(input, context.receiverTypeName)
    ]);
}
function implicitGuiMemberCompletions(input, path) {
    const context = findEnclosingGuiMethodContext(input);
    if (context === undefined) {
        return [];
    }
    const part = resolveGuiPartPath(input, context.rootClassName, path);
    return part === undefined ? [] : guiReceiverCompletions(input, {
        kind: 'guiReceiver',
        rootName: context.rootClassName,
        path: part.part.path
    });
}
function typeMemberCompletions(input, typeName) {
    return declarationsInTypeHierarchy(input, typeName)
        .map((declaration) => ({
        name: declaration.name,
        kind: declaration.kind === 'function' ? 'method' : 'property',
        detail: memberDetail(declaration)
    }));
}
function declarationsInTypeHierarchy(input, typeName) {
    return (0, resolution_1.declarationsInTypeHierarchy)(input, typeName);
}
function resolveMemberAccessType(input, rootTypeName, path) {
    return (0, resolution_1.resolveMemberAccessType)(input, rootTypeName, path);
}
function receiverTypeName(input, receiverName) {
    return (0, resolution_1.receiverTypeName)(input, receiverName);
}
function thisReceiverType(input) {
    return (0, resolution_1.thisReceiverType)(input);
}
function visibleDeclarationCompletions(input, predicate) {
    return listVisibleDeclarations(input)
        .filter(predicate)
        .filter((declaration) => isVisibleAt(declaration, input.position, input.analysis.uri))
        .map(completionFromDeclaration);
}
function completionFromDeclaration(declaration) {
    return {
        name: declaration.name,
        kind: completionKindForDeclaration(declaration),
        detail: declaration.detail
    };
}
function completionKindForDeclaration(declaration) {
    if (declaration.kind === 'function') {
        return declaration.containerName === undefined ? 'function' : 'method';
    }
    if (declaration.kind === 'method') {
        return 'method';
    }
    if (declaration.kind === 'field') {
        return 'property';
    }
    if (declaration.kind === 'variable' || declaration.kind === 'parameter') {
        return declaration.containerName === undefined ? 'variable' : 'property';
    }
    return declaration.kind;
}
function guiPartChildCompletions(parts) {
    return flattenNamedParts(parts)
        .map((part) => ({
        name: part.name,
        kind: 'property',
        detail: `${part.typeName} ${part.path.join('.')}`
    }));
}
function flattenNamedParts(parts) {
    return parts.flatMap((part) => [
        ...(part.name === undefined ? [] : [{ ...part, name: part.name }]),
        ...flattenNamedParts(part.parts)
    ]);
}
function guiEventCompletions(typeName) {
    const names = new Set(COMMON_GUI_EVENTS);
    if (typeName.includes('Dialog')) {
        for (const name of DIALOG_GUI_EVENTS) {
            names.add(name);
        }
    }
    addMatchingEvents(names, typeName, /ListView/, LIST_VIEW_GUI_EVENTS);
    addMatchingEvents(names, typeName, /TableView/, TABLE_VIEW_GUI_EVENTS);
    addMatchingEvents(names, typeName, /Slider/, SLIDER_GUI_EVENTS);
    addMatchingEvents(names, typeName, /Button|CheckBox|ComboBox|ListBox|ControlButton|ButtonGroup/, BUTTON_GUI_EVENTS);
    return Array.from(names).sort().map((name) => ({
        name,
        kind: 'event',
        detail: 'GUI event handler'
    }));
}
function addMatchingEvents(names, typeName, pattern, events) {
    if (!pattern.test(typeName)) {
        return;
    }
    for (const event of events) {
        names.add(event);
    }
}
function listVisibleDeclarations(input) {
    return (0, resolution_1.listVisibleDeclarations)(input);
}
function findEnclosingGuiMethodContext(input) {
    for (const guiClass of input.analysis.guiClasses) {
        const classMethod = guiClass.methods.find((method) => contains(method.range, input.position));
        if (classMethod !== undefined) {
            return { rootClassName: guiClass.name, receiverTypeName: guiClass.name };
        }
        const partMethod = findEnclosingGuiPartMethod(guiClass.parts, input.position);
        if (partMethod !== undefined) {
            return { rootClassName: guiClass.name, receiverTypeName: partMethod.typeName };
        }
    }
    for (const method of input.analysis.guiMethods) {
        if (!contains(method.range, input.position)) {
            continue;
        }
        const rootClassName = method.receiverPath[0];
        if (rootClassName === undefined) {
            continue;
        }
        const partPath = method.receiverPath.slice(1, -1);
        const part = resolveGuiPartPath(input, rootClassName, partPath);
        return {
            rootClassName,
            receiverTypeName: part?.part.typeName ?? rootClassName
        };
    }
    return undefined;
}
function findEnclosingGuiPartMethod(parts, position) {
    for (const part of parts) {
        if (part.methods.some((method) => contains(method.range, position))) {
            return part;
        }
        const child = findEnclosingGuiPartMethod(part.parts, position);
        if (child !== undefined) {
            return child;
        }
    }
    return undefined;
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
function findVisibleGuiClass(input, name) {
    return input.analysis.guiClasses.find((guiClass) => guiClass.name === name)
        ?? input.workspaceIndex.findGuiClass?.(input.analysis.uri, name);
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
function keywordItems(names) {
    return names.map((name) => ({ name, kind: 'keyword' }));
}
function declarationKeywordItems(typedHash) {
    return DECLARATION_KEYWORDS.map((name) => ({
        name,
        kind: 'keyword',
        insertText: typedHash && name.startsWith('#') ? name.slice(1) : undefined
    }));
}
function typeCompletionItems(input) {
    return [
        ...keywordItems(BUILTIN_TYPE_NAMES),
        ...guiClassKinds_1.DIRECT_GUI_BASE_NAMES.map((name) => ({ name, kind: 'class', detail: 'GUI base class' })),
        ...visibleDeclarationCompletions(input, isTypeDeclaration)
    ];
}
function uniqueCompletions(items) {
    const uniqueItems = new Map();
    for (const item of items) {
        const existing = uniqueItems.get(item.name);
        if (existing === undefined || completionPriority(item) > completionPriority(existing)) {
            uniqueItems.set(item.name, item);
        }
    }
    return Array.from(uniqueItems.values())
        .sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
}
function completionPriority(item) {
    if (isTypeCompletionKind(item.kind)) {
        return 2;
    }
    return item.kind === 'keyword' ? 0 : 1;
}
function isTypeCompletionKind(kind) {
    return kind === 'class'
        || kind === 'struct'
        || kind === 'union'
        || kind === 'enum'
        || kind === 'typedef';
}
function isTypeDeclaration(declaration) {
    return (0, resolution_1.isTypeDeclaration)(declaration);
}
function typeDeclarationName(input, name) {
    return listVisibleDeclarations(input)
        .filter((declaration) => declaration.name === name)
        .find(isTypeDeclaration)
        ?.name;
}
function isVisibleAt(declaration, position, sourceUri) {
    return (0, resolution_1.isVisibleAt)(declaration, position, sourceUri);
}
function memberDetail(declaration) {
    if (declaration.containerName === undefined || declaration.detail.includes('::')) {
        return declaration.detail;
    }
    return declaration.detail.replace(declaration.name, `${declaration.containerName}::${declaration.name}`);
}
function offsetFromPosition(text, position) {
    const lines = text.split('\n');
    return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
}
function contains(range, position) {
    return (0, resolution_1.contains)(range, position);
}
function sameStringArray(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}
//# sourceMappingURL=completion.js.map