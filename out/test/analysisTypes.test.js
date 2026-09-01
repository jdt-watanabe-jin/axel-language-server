"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
suite('analysis types', () => {
    test('represent diagnostics and symbols without LSP dependencies', () => {
        const diagnostic = {
            severity: 'error',
            source: 'axel',
            message: 'Syntax error.',
            range: {
                start: { line: 0, character: 1 },
                end: { line: 0, character: 2 }
            }
        };
        const symbol = {
            name: 'main',
            kind: 'function',
            detail: 'function',
            range: diagnostic.range,
            selectionRange: diagnostic.range
        };
        const analyzed = {
            uri: 'file:///main.axl',
            version: 1,
            diagnostics: [diagnostic],
            symbols: [symbol],
            declarations: [],
            references: [],
            scopes: [],
            includes: [],
            scriptExecutions: [],
            guiClasses: [],
            guiMethods: []
        };
        assert.strictEqual(analyzed.diagnostics[0].severity, 'error');
        assert.strictEqual(analyzed.symbols[0].kind, 'function');
    });
});
//# sourceMappingURL=analysisTypes.test.js.map