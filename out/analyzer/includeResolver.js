"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveInclude = resolveInclude;
exports.resolveScriptExecution = resolveScriptExecution;
exports.collectIncludes = collectIncludes;
exports.collectScriptExecutions = collectScriptExecutions;
const fs = require("fs");
const path = require("path");
const url_1 = require("url");
const syntaxTree_1 = require("./syntaxTree");
function resolveInclude(input) {
    const parsed = parseIncludeText(input.includeText);
    if (parsed.kind === 'expression') {
        return {
            status: 'unresolved',
            reason: 'unsupported',
            includePath: parsed.includePath,
            candidates: []
        };
    }
    const candidates = includeCandidates({
        includingFilePath: input.includingFilePath,
        includePath: parsed.includePath,
        kind: parsed.kind,
        includeRoots: input.includeRoots
    });
    const fileExists = input.fileExists ?? fs.existsSync;
    const resolved = candidates.find((candidate) => fileExists(candidate));
    if (resolved === undefined) {
        return {
            status: 'unresolved',
            reason: 'not-found',
            includePath: parsed.includePath,
            candidates
        };
    }
    return {
        status: 'resolved',
        includePath: parsed.includePath,
        filePath: resolved,
        uri: (0, url_1.pathToFileURL)(resolved).toString()
    };
}
function resolveScriptExecution(input) {
    const candidates = scriptExecutionCandidates({
        includingFilePath: input.includingFilePath,
        scriptPath: input.scriptPath,
        includeRoots: input.includeRoots
    });
    const fileExists = input.fileExists ?? fs.existsSync;
    const resolved = candidates.find((candidate) => fileExists(candidate));
    if (resolved === undefined) {
        return {
            status: 'unresolved',
            reason: 'not-found',
            includePath: input.scriptPath,
            candidates
        };
    }
    return {
        status: 'resolved',
        includePath: input.scriptPath,
        filePath: resolved,
        uri: (0, url_1.pathToFileURL)(resolved).toString()
    };
}
function collectIncludes(rootNode) {
    return (0, syntaxTree_1.findNamedNodes)(rootNode, (node) => node.type === 'preproc_include')
        .map((node) => includeFromNode(node))
        .filter((include) => include !== null);
}
function collectScriptExecutions(rootNode) {
    return (0, syntaxTree_1.findNamedNodes)(rootNode, (node) => node.type === 'command_statement')
        .map((node) => scriptExecutionFromNode(node))
        .filter((script) => script !== null);
}
function includeFromNode(node) {
    const pathNode = node.childForFieldName('path');
    if (pathNode === null) {
        return null;
    }
    const parsed = parseIncludeText(pathNode.text);
    return {
        includePath: parsed.includePath,
        kind: parsed.kind,
        range: (0, syntaxTree_1.nodeToAnalysisRange)(pathNode)
    };
}
function scriptExecutionFromNode(node) {
    const fileNode = node.namedChildren.find((child) => child.type === 'command_identifier');
    if (fileNode === undefined) {
        return null;
    }
    return {
        scriptPath: fileNode.text,
        range: rangeFromPositions({ line: node.startPosition.row, character: node.startPosition.column }, { line: fileNode.endPosition.row, character: fileNode.endPosition.column }),
        selectionRange: (0, syntaxTree_1.nodeToAnalysisRange)(fileNode)
    };
}
function includeCandidates(input) {
    const candidates = [];
    if (input.kind === 'quote') {
        candidates.push(path.normalize(path.join(path.dirname(input.includingFilePath), input.includePath)));
    }
    for (const root of input.includeRoots) {
        candidates.push(path.normalize(path.join(root, input.includePath)));
    }
    return Array.from(new Set(candidates));
}
function scriptExecutionCandidates(input) {
    return includeCandidates({
        includingFilePath: input.includingFilePath,
        includePath: input.scriptPath,
        kind: 'quote',
        includeRoots: input.includeRoots
    }).flatMap((candidate) => scriptPathVariants(candidate));
}
function scriptPathVariants(filePath) {
    return path.extname(filePath).length === 0 ? [filePath, `${filePath}.axl`] : [filePath];
}
function parseIncludeText(includeText) {
    const trimmed = includeText.trim();
    const withoutWidePrefix = trimmed.startsWith('L"') ? trimmed.slice(1) : trimmed;
    if (withoutWidePrefix.startsWith('"') && withoutWidePrefix.endsWith('"')) {
        return {
            includePath: withoutWidePrefix.slice(1, -1),
            kind: 'quote'
        };
    }
    if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
        return {
            includePath: trimmed.slice(1, -1),
            kind: 'angle'
        };
    }
    if (/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(trimmed)) {
        return {
            includePath: trimmed,
            kind: 'bare'
        };
    }
    return {
        includePath: trimmed,
        kind: 'expression'
    };
}
function rangeFromPositions(start, end) {
    return { start, end };
}
//# sourceMappingURL=includeResolver.js.map