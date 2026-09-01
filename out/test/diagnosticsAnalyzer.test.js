"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const axelParser_1 = require("../analyzer/axelParser");
const diagnostics_1 = require("../analyzer/diagnostics");
suite('collectSyntaxDiagnostics', () => {
    test('returns no diagnostics for valid AXEL', () => {
        const parser = (0, axelParser_1.createAxelParser)();
        const tree = parser.parse('void main() {}');
        assert.deepStrictEqual((0, diagnostics_1.collectSyntaxDiagnostics)(tree.rootNode), []);
    });
    test('reports parser ERROR nodes as syntax errors', () => {
        const parser = (0, axelParser_1.createAxelParser)();
        const tree = parser.parse('void main( {');
        const diagnostics = (0, diagnostics_1.collectSyntaxDiagnostics)(tree.rootNode);
        assert.ok(diagnostics.length > 0);
        assert.strictEqual(diagnostics[0].severity, 'error');
        assert.strictEqual(diagnostics[0].source, 'axel');
        assert.strictEqual(diagnostics[0].message, 'Syntax error.');
    });
});
//# sourceMappingURL=diagnosticsAnalyzer.test.js.map