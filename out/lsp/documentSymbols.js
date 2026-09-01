"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toLspDocumentSymbol = toLspDocumentSymbol;
const node_1 = require("vscode-languageserver/node");
function toLspDocumentSymbol(symbol) {
    return node_1.DocumentSymbol.create(symbol.name, symbol.detail ?? symbol.kind, toLspSymbolKind(symbol.kind), symbol.range, symbol.selectionRange, symbol.children?.map(toLspDocumentSymbol));
}
function toLspSymbolKind(kind) {
    switch (kind) {
        case 'function':
            return node_1.SymbolKind.Function;
        case 'method':
            return node_1.SymbolKind.Method;
        case 'parameter':
        case 'variable':
            return node_1.SymbolKind.Variable;
        case 'field':
            return node_1.SymbolKind.Field;
        case 'typedef':
            return node_1.SymbolKind.TypeParameter;
        case 'class':
            return node_1.SymbolKind.Class;
        case 'struct':
            return node_1.SymbolKind.Struct;
        case 'union':
            return node_1.SymbolKind.Object;
        case 'enum':
            return node_1.SymbolKind.Enum;
        case 'enumMember':
            return node_1.SymbolKind.EnumMember;
        case 'macro':
            return node_1.SymbolKind.Constant;
        case 'include':
            return node_1.SymbolKind.File;
    }
}
//# sourceMappingURL=documentSymbols.js.map