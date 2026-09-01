"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEMANTIC_TOKEN_LEGEND = void 0;
exports.toLspSemanticTokens = toLspSemanticTokens;
// Keep this legend append-only after release; clients encode token data by numeric index.
exports.SEMANTIC_TOKEN_LEGEND = {
    tokenTypes: [
        'class',
        'enum',
        'enumMember',
        'function',
        'macro',
        'method',
        'parameter',
        'property',
        'struct',
        'type',
        'variable'
    ],
    tokenModifiers: [
        'declaration'
    ]
};
function toLspSemanticTokens(tokens) {
    const data = [];
    let previousLine = 0;
    let previousStartCharacter = 0;
    for (const token of tokens) {
        const line = token.range.start.line;
        const startCharacter = token.range.start.character;
        const deltaLine = line - previousLine;
        const deltaStart = deltaLine === 0
            ? startCharacter - previousStartCharacter
            : startCharacter;
        data.push(deltaLine, deltaStart, token.range.end.character - token.range.start.character, tokenTypeIndex(token.tokenType), tokenModifierBitset(token.modifiers));
        previousLine = line;
        previousStartCharacter = startCharacter;
    }
    return { data };
}
function tokenTypeIndex(tokenType) {
    return exports.SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf(tokenType);
}
function tokenModifierBitset(modifiers) {
    return modifiers.reduce((bitset, modifier) => {
        const index = exports.SEMANTIC_TOKEN_LEGEND.tokenModifiers.indexOf(modifier);
        return index < 0 ? bitset : bitset | (1 << index);
    }, 0);
}
//# sourceMappingURL=semanticTokens.js.map