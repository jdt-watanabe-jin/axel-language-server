import {
  DiagnosticSeverity,
  DocumentDiagnosticReportKind,
  type Diagnostic,
  type DocumentDiagnosticReport
} from 'vscode-languageserver/node';
import type { AnalysisDiagnostic } from '../types/analysis';

export function toLspDiagnostic(diagnostic: AnalysisDiagnostic): Diagnostic {
  return {
    severity: toLspDiagnosticSeverity(diagnostic.severity),
    range: diagnostic.range,
    message: diagnostic.message,
    source: diagnostic.source
  };
}

export function toDocumentDiagnosticReport(
  diagnostics: AnalysisDiagnostic[]
): DocumentDiagnosticReport {
  return {
    kind: DocumentDiagnosticReportKind.Full,
    items: diagnostics.map(toLspDiagnostic)
  };
}

function toLspDiagnosticSeverity(severity: AnalysisDiagnostic['severity']): DiagnosticSeverity {
  return severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error;
}
