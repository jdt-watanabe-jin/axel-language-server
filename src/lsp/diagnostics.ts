import {
  DiagnosticSeverity,
  DocumentDiagnosticReportKind,
  type Diagnostic,
  type DocumentDiagnosticReport
} from 'vscode-languageserver/node';
import type { AnalysisDiagnostic } from '../types/analysis';
import { formatMessage } from '../i18n/messages';

export function toLspDiagnostic(diagnostic: AnalysisDiagnostic, locale?: string): Diagnostic {
  return {
    severity: toLspDiagnosticSeverity(diagnostic.severity),
    range: diagnostic.range,
    message: diagnostic.messageDescriptor === undefined ? diagnostic.message : formatMessage(diagnostic.messageDescriptor, locale),
    source: diagnostic.source
  };
}

export function toDocumentDiagnosticReport(
  diagnostics: AnalysisDiagnostic[],
  locale?: string
): DocumentDiagnosticReport {
  return {
    kind: DocumentDiagnosticReportKind.Full,
    items: diagnostics.map((diagnostic) => toLspDiagnostic(diagnostic, locale))
  };
}

function toLspDiagnosticSeverity(severity: AnalysisDiagnostic['severity']): DiagnosticSeverity {
  return severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error;
}
