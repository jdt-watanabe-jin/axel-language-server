"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toLspDiagnostic = toLspDiagnostic;
exports.toDocumentDiagnosticReport = toDocumentDiagnosticReport;
const node_1 = require("vscode-languageserver/node");
function toLspDiagnostic(diagnostic) {
    return {
        severity: toLspDiagnosticSeverity(diagnostic.severity),
        range: diagnostic.range,
        message: diagnostic.message,
        source: diagnostic.source
    };
}
function toDocumentDiagnosticReport(diagnostics) {
    return {
        kind: node_1.DocumentDiagnosticReportKind.Full,
        items: diagnostics.map(toLspDiagnostic)
    };
}
function toLspDiagnosticSeverity(severity) {
    return severity === 'warning' ? node_1.DiagnosticSeverity.Warning : node_1.DiagnosticSeverity.Error;
}
//# sourceMappingURL=diagnostics.js.map