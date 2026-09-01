"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildGuiIndex = buildGuiIndex;
exports.collectExternalGuiMethods = collectExternalGuiMethods;
const guiClassKinds_1 = require("./guiClassKinds");
const syntaxTree_1 = require("./syntaxTree");
function buildGuiIndex(rootNode, _uri, knownGuiClasses = new Set()) {
    const resolvedGuiClasses = resolveKnownGuiClasses(rootNode, knownGuiClassMap(knownGuiClasses));
    const classes = collectGuiClasses(rootNode, resolvedGuiClasses);
    const classByName = new Map(classes.map((guiClass) => [guiClass.name, guiClass]));
    for (const method of collectExternalGuiMethods(rootNode)) {
        const rootClass = method.receiverPath[0];
        const guiClass = rootClass === undefined ? undefined : classByName.get(rootClass);
        guiClass?.methods.push(method);
    }
    return classes;
}
function resolveKnownGuiClasses(rootNode, initialClasses) {
    const classesByName = new Map(initialClasses);
    let previousSize = -1;
    while (classesByName.size !== previousSize) {
        previousSize = classesByName.size;
        for (const guiClass of collectGuiClasses(rootNode, classesByName)) {
            if (!classesByName.has(guiClass.name)) {
                classesByName.set(guiClass.name, guiClass.kind);
            }
        }
    }
    return classesByName;
}
function collectGuiClasses(rootNode, knownGuiClasses) {
    const classes = [];
    function visit(node) {
        if (node.type === 'class_specifier') {
            const guiClass = guiClassFromNode(node, knownGuiClasses);
            if (guiClass !== undefined) {
                classes.push(guiClass);
            }
        }
        for (const child of node.namedChildren) {
            visit(child);
        }
    }
    visit(rootNode);
    return classes;
}
function guiClassFromNode(node, knownGuiClasses) {
    const nameNode = node.childForFieldName('name');
    const baseName = baseNameFromClassSpecifier(node);
    if (nameNode === null || baseName === undefined) {
        return undefined;
    }
    const kind = classifyGuiClassKind(baseName, knownGuiClasses);
    if (kind === undefined) {
        return undefined;
    }
    const bodyNode = node.childForFieldName('body');
    return {
        name: nameNode.text,
        baseName,
        kind,
        range: (0, syntaxTree_1.nodeToAnalysisRange)(node),
        parts: bodyNode === null ? [] : collectGuiParts(bodyNode, [], knownGuiClasses),
        methods: bodyNode === null ? [] : collectInlineGuiMethods(bodyNode, [nameNode.text])
    };
}
function classifyGuiClassKind(baseName, knownGuiClasses) {
    const directKind = (0, guiClassKinds_1.classifyDirectGuiBase)(baseName);
    if (directKind !== undefined) {
        return directKind;
    }
    const knownKind = knownGuiClasses.get(baseName);
    if (knownKind !== undefined) {
        return knownKind;
    }
    if (/^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(baseName)) {
        return 'guiPart';
    }
    return undefined;
}
function baseNameFromClassSpecifier(node) {
    const baseClause = node.namedChildren.find((child) => child.type === 'base_class_clause');
    return baseClause?.namedChildren.find((child) => isTypeNameNode(child))?.text;
}
function collectGuiParts(node, parentPath, knownGuiClasses) {
    const parts = [];
    for (const child of node.namedChildren) {
        if (child.type !== 'gins_definition' && child.type !== 'field_declaration') {
            continue;
        }
        const part = guiPartFromNode(child, parentPath, knownGuiClasses);
        if (part !== undefined) {
            parts.push(part);
        }
    }
    return parts;
}
function guiPartFromNode(node, parentPath, knownGuiClasses) {
    const typeName = node.childForFieldName('type')?.text;
    if (typeName === undefined || !(0, guiClassKinds_1.isGuiPartTypeName)(typeName, new Set(knownGuiClasses.keys()))) {
        return undefined;
    }
    const nameNode = partNameNode(node);
    const name = nameNode?.text;
    const anonymous = name === undefined;
    const path = anonymous ? parentPath : [...parentPath, name];
    return {
        name,
        typeName,
        path,
        anonymous,
        range: (0, syntaxTree_1.nodeToAnalysisRange)(node),
        ...(nameNode === null ? {} : { selectionRange: (0, syntaxTree_1.nodeToAnalysisRange)(nameNode) }),
        parts: collectGuiParts(node, path, knownGuiClasses),
        methods: collectInlineGuiMethods(node, path)
    };
}
function knownGuiClassMap(knownGuiClasses) {
    if (knownGuiClasses instanceof Map) {
        return knownGuiClasses;
    }
    return new Map(Array.from(knownGuiClasses).map((name) => [name, 'guiPart']));
}
function partNameNode(node) {
    return node.childForFieldName('name') ?? declaratorNameFromNode(node);
}
function declaratorNameFromNode(node) {
    if (node.type === 'identifier' || node.type === 'class_name') {
        return node;
    }
    const declarator = node.childForFieldName('declarator');
    if (declarator === null) {
        return null;
    }
    return declarator.type === 'identifier' || declarator.type === 'class_name'
        ? declarator
        : (0, syntaxTree_1.getDeclaratorName)(declarator);
}
function collectInlineGuiMethods(node, receiverPath) {
    const methods = [];
    for (const child of node.namedChildren) {
        if (child.type !== 'gins_attributes_definition' && child.type !== 'function_definition') {
            continue;
        }
        const method = methodFromFunctionNode(child, receiverPath);
        if (method !== undefined) {
            methods.push(method);
        }
    }
    return methods;
}
function collectExternalGuiMethods(rootNode) {
    const methods = [];
    function visit(node) {
        if (node.type === 'function_definition') {
            const method = externalMethodFromFunctionNode(node);
            if (method !== undefined) {
                methods.push(method);
            }
        }
        for (const child of node.namedChildren) {
            visit(child);
        }
    }
    visit(rootNode);
    return methods;
}
function methodFromFunctionNode(node, receiverPath) {
    const nameNode = functionNameNode(node);
    if (nameNode === null) {
        return undefined;
    }
    return {
        name: nameNode.text,
        receiverPath: [...receiverPath, nameNode.text],
        selectionRange: (0, syntaxTree_1.nodeToAnalysisRange)(nameNode),
        event: isGuiEventName(nameNode.text),
        range: (0, syntaxTree_1.nodeToAnalysisRange)(node)
    };
}
function externalMethodFromFunctionNode(node) {
    const qualified = findQualifiedDeclarator(node);
    const scope = qualified?.childForFieldName('scope');
    const name = qualified?.childForFieldName('name');
    if (qualified === undefined || scope === null || scope === undefined || name === null || name === undefined) {
        return undefined;
    }
    const instanceSegments = instancePathSegments(qualified);
    return {
        name: name.text,
        receiverPath: [scope.text, ...instanceSegments.map((segment) => segment.name), name.text],
        receiverPathSegmentRanges: [
            (0, syntaxTree_1.nodeToAnalysisRange)(scope),
            ...instanceSegments.map((segment) => segment.range),
            (0, syntaxTree_1.nodeToAnalysisRange)(name)
        ],
        selectionRange: (0, syntaxTree_1.nodeToAnalysisRange)(name),
        event: isGuiEventName(name.text),
        range: (0, syntaxTree_1.nodeToAnalysisRange)(node)
    };
}
function findQualifiedDeclarator(node) {
    if (node.type === 'qualified_declarator') {
        return node;
    }
    for (const child of node.namedChildren) {
        const found = findQualifiedDeclarator(child);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
}
function functionNameNode(node) {
    const declarator = node.childForFieldName('declarator');
    return declarator === null ? null : (0, syntaxTree_1.getDeclaratorName)(declarator);
}
function instancePathSegments(qualifiedDeclarator) {
    const instance = qualifiedDeclarator.childForFieldName('instance');
    if (instance === null) {
        return [];
    }
    return identifierSegmentsFromInstanceName(instance);
}
function identifierSegmentsFromInstanceName(node) {
    const segments = [];
    for (const child of node.namedChildren) {
        if (child.type === 'identifier') {
            segments.push({
                name: child.text,
                range: (0, syntaxTree_1.nodeToAnalysisRange)(child)
            });
            continue;
        }
        if (child.type === 'instance_name') {
            segments.push(...identifierSegmentsFromInstanceName(child));
        }
    }
    return segments;
}
function isGuiEventName(name) {
    return /^On[A-Za-z_][0-9A-Za-z_$]*$/.test(name);
}
function isTypeNameNode(node) {
    return node.type === 'class_name'
        || node.type === 'gins_class'
        || node.type === 'gtop_class'
        || node.type === 'identifier';
}
//# sourceMappingURL=guiIndex.js.map