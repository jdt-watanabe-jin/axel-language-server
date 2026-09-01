"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const axelParser_1 = require("../analyzer/axelParser");
suite('createAxelParser', () => {
    test('parses a simple AXEL translation unit', () => {
        const parser = (0, axelParser_1.createAxelParser)();
        const tree = parser.parse('void main() {}');
        assert.strictEqual(tree.rootNode.type, 'translation_unit');
        assert.strictEqual(tree.rootNode.hasError, false);
    });
});
//# sourceMappingURL=axelParser.test.js.map