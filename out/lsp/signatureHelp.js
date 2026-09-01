"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toLspSignatureHelp = toLspSignatureHelp;
function toLspSignatureHelp(signatureHelp) {
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
//# sourceMappingURL=signatureHelp.js.map