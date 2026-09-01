"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toLspHover = toLspHover;
const node_1 = require("vscode-languageserver/node");
function toLspHover(hover) {
    return {
        contents: {
            kind: node_1.MarkupKind.Markdown,
            value: hover.markdown
        }
    };
}
//# sourceMappingURL=hover.js.map