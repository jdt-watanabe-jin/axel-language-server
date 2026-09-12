import type { SignatureHelp } from 'vscode-languageserver/node';
import type { AnalysisSignatureHelp } from '../types/analysis';

export function toLspSignatureHelp(signatureHelp: AnalysisSignatureHelp, markdown = true): SignatureHelp {
  return {
    signatures: signatureHelp.signatures.map((signature) => ({
      label: signature.label,
      ...(signature.documentation === undefined ? {} : { documentation: markdown && signature.documentationMarkdown !== undefined ? {kind: 'markdown' as const, value: signature.documentationMarkdown} : signature.documentation }),
      parameters: signature.parameters.map((parameter) => ({
        label: parameter.label,
        ...(parameter.documentation === undefined ? {} : { documentation: markdown && parameter.documentationMarkdown !== undefined ? {kind: 'markdown' as const, value: parameter.documentationMarkdown} : parameter.documentation })
      }))
    })),
    activeSignature: signatureHelp.activeSignature,
    activeParameter: signatureHelp.activeParameter
  };
}
