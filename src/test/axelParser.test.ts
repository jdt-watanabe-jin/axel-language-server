import * as assert from 'assert';
import { createAxelParser } from '../analyzer/axelParser';

suite('createAxelParser', () => {
  test('parses a simple AXEL translation unit', () => {
    const parser = createAxelParser();
    const tree = parser.parse('void main() {}');

    assert.strictEqual(tree.rootNode.type, 'translation_unit');
    assert.strictEqual(tree.rootNode.hasError, false);
  });
});
