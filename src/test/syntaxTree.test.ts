import * as assert from 'assert';
import { createAxelParser } from '../analyzer/axelParser';
import { isDeclarationNodeType, isIncludeNodeType, isTypeSpecifierNodeType } from '../analyzer/nodeKinds';
import { findNamedNodes, getDeclaratorName, nodeToAnalysisRange } from '../analyzer/syntaxTree';

suite('syntax tree helpers', () => {
  test('identify declaration and type specifier node types from grammar', () => {
    assert.strictEqual(isDeclarationNodeType('function_definition'), true);
    assert.strictEqual(isDeclarationNodeType('object_definition'), true);
    assert.strictEqual(isDeclarationNodeType('type_definition'), true);
    assert.strictEqual(isTypeSpecifierNodeType('class_specifier'), true);
    assert.strictEqual(isTypeSpecifierNodeType('struct_specifier'), true);
    assert.strictEqual(isTypeSpecifierNodeType('union_specifier'), true);
    assert.strictEqual(isTypeSpecifierNodeType('enum_specifier'), true);
    assert.strictEqual(isIncludeNodeType('preproc_include'), true);
    assert.strictEqual(isDeclarationNodeType('identifier'), false);
  });

  test('convert tree-sitter positions to analyzer ranges', () => {
    const parser = createAxelParser();
    const tree = parser.parse('void main() {}');
    const func = findNamedNodes(tree.rootNode, (node) => node.type === 'function_definition')[0];
    const range = nodeToAnalysisRange(func);

    assert.deepStrictEqual(range.start, { line: 0, character: 0 });
    assert.deepStrictEqual(range.end, { line: 0, character: 14 });
  });

  test('extract nested declarator names', () => {
    const parser = createAxelParser();
    const tree = parser.parse('int *value;');
    const object = findNamedNodes(tree.rootNode, (node) => node.type === 'object_definition')[0];
    const name = getDeclaratorName(object);

    assert.strictEqual(name?.text, 'value');
  });
});
