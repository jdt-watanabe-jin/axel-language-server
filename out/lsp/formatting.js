"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toLspTextEdits = toLspTextEdits;
function toLspTextEdits(edits) {
    return edits.map((edit) => ({
        range: edit.range,
        newText: edit.newText
    }));
}
//# sourceMappingURL=formatting.js.map