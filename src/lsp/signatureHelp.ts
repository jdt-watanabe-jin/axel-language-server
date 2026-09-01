import type { SignatureHelp } from 'vscode-languageserver/node';
import type { AnalysisSignatureHelp } from '../types/analysis';

export function toLspSignatureHelp(signatureHelp: AnalysisSignatureHelp): SignatureHelp {
  return {
    signatures: signatureHelp.signatures.map((signature) => ({
      label: signature.label,
      parameters: signature.parameters.map((parameter) => ({
        label: parameter.label
      }))
    })),
    activeSignature: signatureHelp.activeSignature,
    activeParameter: signatureHelp.activeParameter
  };
}
