"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toLspCodeActions = toLspCodeActions;
const node_1 = require("vscode-languageserver/node");
const diagnostics_1 = require("./diagnostics");
const rename_1 = require("./rename");
function toLspCodeActions(actions) {
    return actions.map((action) => ({
        title: action.title,
        kind: node_1.CodeActionKind.QuickFix,
        diagnostics: action.diagnostics.map(diagnostics_1.toLspDiagnostic),
        edit: (0, rename_1.toLspWorkspaceEdit)(action.edit)
    }));
}
//# sourceMappingURL=codeActions.js.map