"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectDocumentSymbols = collectDocumentSymbols;
const nodeKinds_1 = require("./nodeKinds");
const syntaxTree_1 = require("./syntaxTree");
function collectDocumentSymbols(rootNode, options = {}) {
    const symbols = [];
    const nestedGuiMethods = nestableGuiMethods(options);
    for (const child of rootNode.namedChildren) {
        const symbol = symbolFromNode(child, { nestedGuiMethods });
        if (symbol !== null) {
            symbols.push(symbol);
        }
    }
    return attachGuiSymbols(symbols, options);
}
function symbolFromNode(node, context) {
    if ((0, nodeKinds_1.isIncludeNodeType)(node.type)) {
        return includeSymbolFromNode(node);
    }
    const macroSymbol = macroSymbolFromNode(node);
    if (macroSymbol !== null) {
        return macroSymbol;
    }
    if ((0, nodeKinds_1.isDeclarationNodeType)(node.type)) {
        return declarationSymbolFromNode(node, context);
    }
    if ((0, nodeKinds_1.isTypeSpecifierNodeType)(node.type)) {
        return typeSymbolFromNode(node, context);
    }
    return null;
}
function includeSymbolFromNode(node) {
    const pathNode = node.childForFieldName('path');
    if (pathNode === null) {
        return null;
    }
    return {
        name: includePathName(pathNode.text),
        kind: 'include',
        detail: normalizeSymbolText(node.text),
        range: (0, syntaxTree_1.nodeToAnalysisRange)(node),
        selectionRange: (0, syntaxTree_1.nodeToAnalysisRange)(pathNode)
    };
}
function macroSymbolFromNode(node) {
    if (node.type !== 'preproc_def' && node.type !== 'preproc_function_def') {
        return null;
    }
    const nameNode = node.childForFieldName('name');
    if (nameNode === null) {
        return null;
    }
    return {
        name: nameNode.text,
        kind: 'macro',
        detail: normalizeSymbolText(node.text),
        range: (0, syntaxTree_1.nodeToAnalysisRange)(node),
        selectionRange: (0, syntaxTree_1.nodeToAnalysisRange)(nameNode)
    };
}
function declarationSymbolFromNode(node, context) {
    if (node.type === 'function_definition' && context.nestedGuiMethods.has(rangeKey((0, syntaxTree_1.nodeToAnalysisRange)(node)))) {
        return null;
    }
    const nameNode = (0, syntaxTree_1.getDeclaratorName)(node);
    if (nameNode === null) {
        return null;
    }
    const kind = declarationKind(node.type, context.containerKind);
    return {
        name: nameNode.text,
        kind,
        detail: kind,
        range: (0, syntaxTree_1.nodeToAnalysisRange)(node),
        selectionRange: (0, syntaxTree_1.nodeToAnalysisRange)(nameNode)
    };
}
function typeSymbolFromNode(node, context) {
    const nameNode = node.childForFieldName('name');
    if (nameNode === null) {
        return null;
    }
    const kind = typeKind(node.type);
    const children = childSymbolsFromTypeNode(node, kind, context);
    return {
        name: nameNode.text,
        kind,
        detail: kind,
        range: (0, syntaxTree_1.nodeToAnalysisRange)(node),
        selectionRange: (0, syntaxTree_1.nodeToAnalysisRange)(nameNode),
        ...(children.length === 0 ? {} : { children })
    };
}
function childSymbolsFromTypeNode(node, kind, context) {
    if (node.type === 'enum_specifier') {
        return enumMemberSymbolsFromNode(node, node.childForFieldName('name')?.text ?? '');
    }
    if (!['class', 'struct', 'union'].includes(kind)) {
        return [];
    }
    const bodyNode = node.childForFieldName('body');
    if (bodyNode === null) {
        return [];
    }
    return bodyNode.namedChildren.flatMap((child) => {
        const symbol = symbolFromNode(child, { ...context, containerKind: kind });
        return symbol === null ? [] : [symbol];
    });
}
function enumMemberSymbolsFromNode(enumNode, enumName) {
    const bodyNode = enumNode.childForFieldName('body');
    if (bodyNode === null) {
        return [];
    }
    return bodyNode.namedChildren
        .filter((child) => child.type === 'enumerator')
        .flatMap((enumerator) => enumMemberSymbolFromNode(enumerator, enumName));
}
function enumMemberSymbolFromNode(enumerator, enumName) {
    const nameNode = enumerator.childForFieldName('name');
    if (nameNode === null) {
        return [];
    }
    const valueNode = enumerator.childForFieldName('value');
    const valueText = valueNode === null ? '' : ` = ${normalizeSymbolText(valueNode.text)}`;
    return [{
            name: nameNode.text,
            kind: 'enumMember',
            detail: `enum ${enumName}::${nameNode.text}${valueText}`,
            range: (0, syntaxTree_1.nodeToAnalysisRange)(enumerator),
            selectionRange: (0, syntaxTree_1.nodeToAnalysisRange)(nameNode)
        }];
}
function declarationKind(type, containerKind) {
    if (type === 'function_definition') {
        return containerKind === undefined ? 'function' : 'method';
    }
    if (type === 'type_definition') {
        return 'typedef';
    }
    return containerKind === undefined ? 'variable' : 'field';
}
function typeKind(type) {
    if (type === 'struct_specifier') {
        return 'struct';
    }
    if (type === 'union_specifier') {
        return 'union';
    }
    if (type === 'enum_specifier') {
        return 'enum';
    }
    return 'class';
}
function normalizeSymbolText(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function includePathName(text) {
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('<') && text.endsWith('>'))) {
        return text.slice(1, -1);
    }
    return text;
}
function attachGuiSymbols(symbols, options) {
    if (options.guiClasses === undefined || options.guiClasses.length === 0) {
        return symbols;
    }
    const externalMethods = uniqueGuiMethods(options.guiMethods ?? []);
    for (const guiClass of options.guiClasses) {
        const classSymbol = symbols.find((symbol) => (symbol.kind === 'class'
            && symbol.name === guiClass.name
            && rangeKey(symbol.range) === rangeKey(guiClass.range)));
        if (classSymbol === undefined) {
            continue;
        }
        const syntaxChildren = (classSymbol.children ?? []).filter((child) => !isGuiPartChild(child, guiClass.parts));
        classSymbol.detail = `class ${guiClass.name} : public ${guiClass.baseName}`;
        classSymbol.children = sortSymbols([
            ...syntaxChildren,
            ...visibleGuiPartSymbols(guiClass, guiClass.parts, externalMethods),
            ...classGuiMethodSymbols(guiClass, externalMethods)
        ]);
    }
    return symbols;
}
function visibleGuiPartSymbols(guiClass, parts, externalMethods) {
    return parts.flatMap((part) => {
        if (part.anonymous || part.name === undefined) {
            return visibleGuiPartSymbols(guiClass, part.parts, externalMethods);
        }
        const childSymbols = sortSymbols([
            ...visibleGuiPartSymbols(guiClass, part.parts, externalMethods),
            ...part.methods.map((method) => guiMethodSymbol(method)),
            ...externalPartMethodSymbols(guiClass, part, externalMethods)
        ]);
        return [{
                name: part.name,
                kind: 'field',
                detail: `${part.typeName} ${guiClass.name}::${part.path.join('.')}`,
                range: part.range,
                selectionRange: part.selectionRange ?? part.range,
                ...(childSymbols.length === 0 ? {} : { children: childSymbols })
            }];
    });
}
function classGuiMethodSymbols(guiClass, externalMethods) {
    return uniqueGuiMethods([
        ...guiClass.methods.filter((method) => isClassMethod(guiClass, method)),
        ...externalMethods.filter((method) => isClassMethod(guiClass, method))
    ]).map((method) => guiMethodSymbol(method));
}
function externalPartMethodSymbols(guiClass, part, externalMethods) {
    return uniqueGuiMethods([
        ...guiClass.methods,
        ...externalMethods
    ]).filter((method) => isPartMethod(guiClass, part, method)).map((method) => guiMethodSymbol(method));
}
function guiMethodSymbol(method) {
    return {
        name: method.name,
        kind: 'method',
        detail: `void ${method.receiverPath.join('::')}()`,
        range: method.range,
        selectionRange: method.selectionRange ?? method.range
    };
}
function isClassMethod(guiClass, method) {
    return method.receiverPath.length === 2
        && method.receiverPath[0] === guiClass.name
        && method.receiverPath[1] === method.name;
}
function isPartMethod(guiClass, part, method) {
    return method.receiverPath.length === part.path.length + 2
        && method.receiverPath[0] === guiClass.name
        && method.receiverPath[method.receiverPath.length - 1] === method.name
        && samePath(method.receiverPath.slice(1, -1), part.path);
}
function isGuiPartChild(symbol, parts) {
    return visibleGuiPartNames(parts).has(symbol.name);
}
function visibleGuiPartNames(parts) {
    const names = new Set();
    for (const part of parts) {
        if (part.name !== undefined) {
            names.add(part.name);
        }
        for (const childName of visibleGuiPartNames(part.parts)) {
            names.add(childName);
        }
    }
    return names;
}
function nestableGuiMethods(options) {
    const ranges = new Set();
    for (const guiClass of options.guiClasses ?? []) {
        for (const method of uniqueGuiMethods([...(options.guiMethods ?? []), ...guiClass.methods])) {
            if (canNestGuiMethod(guiClass, method)) {
                ranges.add(rangeKey(method.range));
            }
        }
    }
    return ranges;
}
function canNestGuiMethod(guiClass, method) {
    if (isClassMethod(guiClass, method)) {
        return true;
    }
    return findGuiPart(guiClass.parts, (part) => isPartMethod(guiClass, part, method)) !== undefined;
}
function findGuiPart(parts, predicate) {
    for (const part of parts) {
        if (predicate(part)) {
            return part;
        }
        const found = findGuiPart(part.parts, predicate);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
}
function uniqueGuiMethods(methods) {
    const seen = new Set();
    const results = [];
    for (const method of methods) {
        const key = `${rangeKey(method.range)}:${method.receiverPath.join('\u0000')}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        results.push(method);
    }
    return results;
}
function samePath(left, right) {
    return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
function sortSymbols(symbols) {
    return [...symbols].sort((left, right) => (left.range.start.line - right.range.start.line
        || left.range.start.character - right.range.start.character
        || left.range.end.line - right.range.end.line
        || left.range.end.character - right.range.end.character));
}
function rangeKey(range) {
    return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}
//# sourceMappingURL=documentSymbols.js.map