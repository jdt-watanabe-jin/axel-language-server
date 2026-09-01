"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const axelParser_1 = require("../analyzer/axelParser");
const nodeKinds_1 = require("../analyzer/nodeKinds");
const syntaxTree_1 = require("../analyzer/syntaxTree");
suite('syntax tree helpers', () => {
    test('identify declaration and type specifier node types from grammar', () => {
        assert.strictEqual((0, nodeKinds_1.isDeclarationNodeType)('function_definition'), true);
        assert.strictEqual((0, nodeKinds_1.isDeclarationNodeType)('object_definition'), true);
        assert.strictEqual((0, nodeKinds_1.isDeclarationNodeType)('type_definition'), true);
        assert.strictEqual((0, nodeKinds_1.isTypeSpecifierNodeType)('class_specifier'), true);
        assert.strictEqual((0, nodeKinds_1.isTypeSpecifierNodeType)('struct_specifier'), true);
        assert.strictEqual((0, nodeKinds_1.isTypeSpecifierNodeType)('union_specifier'), true);
        assert.strictEqual((0, nodeKinds_1.isTypeSpecifierNodeType)('enum_specifier'), true);
        assert.strictEqual((0, nodeKinds_1.isIncludeNodeType)('preproc_include'), true);
        assert.strictEqual((0, nodeKinds_1.isDeclarationNodeType)('identifier'), false);
    });
    test('convert tree-sitter positions to analyzer ranges', () => {
        const parser = (0, axelParser_1.createAxelParser)();
        const tree = parser.parse('void main() {}');
        const func = (0, syntaxTree_1.findNamedNodes)(tree.rootNode, (node) => node.type === 'function_definition')[0];
        const range = (0, syntaxTree_1.nodeToAnalysisRange)(func);
        assert.deepStrictEqual(range.start, { line: 0, character: 0 });
        assert.deepStrictEqual(range.end, { line: 0, character: 14 });
    });
    test('extract nested declarator names', () => {
        const parser = (0, axelParser_1.createAxelParser)();
        const tree = parser.parse('int *value;');
        const object = (0, syntaxTree_1.findNamedNodes)(tree.rootNode, (node) => node.type === 'object_definition')[0];
        const name = (0, syntaxTree_1.getDeclaratorName)(object);
        assert.strictEqual(name?.text, 'value');
    });
});
//# sourceMappingURL=syntaxTree.test.js.map