"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toLspCompletionItem = toLspCompletionItem;
const node_1 = require("vscode-languageserver/node");
function toLspCompletionItem(item) {
    return {
        label: item.name,
        kind: toCompletionItemKind(item.kind),
        detail: item.detail,
        documentation: item.documentation,
        insertText: item.insertText,
        filterText: item.filterText,
        sortText: item.sortText
    };
}
function toCompletionItemKind(kind) {
    switch (kind) {
        case 'function':
            return node_1.CompletionItemKind.Function;
        case 'method':
        case 'event':
            return node_1.CompletionItemKind.Method;
        case 'variable':
            return node_1.CompletionItemKind.Variable;
        case 'property':
            return node_1.CompletionItemKind.Property;
        case 'class':
            return node_1.CompletionItemKind.Class;
        case 'struct':
            return node_1.CompletionItemKind.Struct;
        case 'union':
            return node_1.CompletionItemKind.Struct;
        case 'enum':
            return node_1.CompletionItemKind.Enum;
        case 'enumMember':
            return node_1.CompletionItemKind.EnumMember;
        case 'macro':
            return node_1.CompletionItemKind.Constant;
        case 'typedef':
            return node_1.CompletionItemKind.TypeParameter;
        case 'include':
            return node_1.CompletionItemKind.File;
        case 'keyword':
            return node_1.CompletionItemKind.Keyword;
    }
}
//# sourceMappingURL=completion.js.map