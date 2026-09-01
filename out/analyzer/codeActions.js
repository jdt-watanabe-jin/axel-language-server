"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCodeActions = getCodeActions;
const path = require("path");
const url_1 = require("url");
const resolution_1 = require("./resolution");
function getCodeActions(input) {
    return input.diagnostics
        .filter((diagnostic) => rangesIntersect(diagnostic.range, input.range))
        .flatMap((diagnostic) => includeQuickFix(input, diagnostic));
}
function includeQuickFix(input, diagnostic) {
    const missingTypeName = missingTypeNameFromDiagnostic(diagnostic);
    if (missingTypeName === undefined) {
        return [];
    }
    const candidates = (input.workspaceIndex.findDeclarations?.(missingTypeName) ?? [])
        .filter(resolution_1.isTypeDeclaration)
        .filter((declaration) => declaration.uri !== input.analysis.uri);
    if (candidates.length !== 1) {
        return [];
    }
    const includePath = relativeIncludePath(input.analysis.uri, candidates[0].uri);
    if (includePath === undefined) {
        return [];
    }
    return [{
            title: `Add include "${includePath}"`,
            kind: 'quickfix',
            diagnostics: [diagnostic],
            edit: includeWorkspaceEdit(input.analysis.uri, includePath)
        }];
}
function missingTypeNameFromDiagnostic(diagnostic) {
    const match = /^Unknown type '([^']+)'\.$/.exec(diagnostic.message);
    return match?.[1];
}
function includeWorkspaceEdit(sourceUri, includePath) {
    return {
        changes: {
            [sourceUri]: [{
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 }
                    },
                    newText: `#include "${includePath}"\n`
                }]
        }
    };
}
function relativeIncludePath(sourceUri, targetUri) {
    const sourcePath = filePathFromUri(sourceUri);
    const targetPath = filePathFromUri(targetUri);
    if (sourcePath === undefined || targetPath === undefined) {
        return undefined;
    }
    return path.relative(path.dirname(sourcePath), targetPath).replace(/\\/g, '/');
}
function filePathFromUri(uri) {
    try {
        return (0, url_1.fileURLToPath)(uri);
    }
    catch {
        return undefined;
    }
}
function rangesIntersect(left, right) {
    return positionBefore(left.start, right.end) && positionBefore(right.start, left.end);
}
function positionBefore(left, right) {
    return left.line < right.line || (left.line === right.line && left.character < right.character);
}
//# sourceMappingURL=codeActions.js.map