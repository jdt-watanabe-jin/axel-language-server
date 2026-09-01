"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectSyntaxDiagnostics = collectSyntaxDiagnostics;
const syntaxTree_1 = require("./syntaxTree");
function collectSyntaxDiagnostics(rootNode) {
    const errorNodes = (0, syntaxTree_1.findNamedNodes)(rootNode, (node) => node.type === 'ERROR' || node.isMissing);
    return errorNodes.map((node) => ({
        severity: 'error',
        source: 'axel',
        message: node.isMissing ? `Missing ${node.type}.` : 'Syntax error.',
        range: (0, syntaxTree_1.nodeToAnalysisRange)(node)
    }));
}
//# sourceMappingURL=diagnostics.js.map