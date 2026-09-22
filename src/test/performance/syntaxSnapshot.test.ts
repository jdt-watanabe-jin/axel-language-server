import * as assert from 'assert';
import { createAxelParser } from '../../analyzer/axelParser';
import { buildTypeSnapshot } from '../../analyzer/typeChecking/syntax';
suite('Syntax snapshot traversal',()=>{
  test('bounds native root reads while preserving snapshot children and fields', () => {
    const root = createAxelParser().parse('int first; int second; void f(){first=second;}').rootNode;
    let reads = 0;
    for (const key of ['child', 'fieldNameForChild'] as const) {
      const original = root[key].bind(root);
      Object.defineProperty(root, key, { configurable: true, value: (index: number) => { reads++; return original(index); } });
    }
    for (const key of ['children', 'namedChildren'] as const) {
      const children = root[key];
      Object.defineProperty(root, key, { configurable: true, get() { reads++; return children; } });
    }
    const result = buildTypeSnapshot(root, 'file:///snapshot.axl');
    assert.deepStrictEqual(result.root.children.map(child => child.kind), ['object_definition', 'object_definition', 'function_definition']);
    assert.strictEqual(result.root.children[0].fields.declarator[0].text, 'first');
    assert.ok(reads <= root.childCount * 3 + 2, 'Native reads must stay bounded by the number of children');
  });
  test('preserves Unicode text and absolute offsets when snapshotting a subtree', () => {
    const text = '// 日本語 😀\r\nvoid f(){ string x = "日本語 😀"; }';
    const root = createAxelParser().parse(text).rootNode;
    const fn = root.descendantsOfType('function_definition')[0];
    const snapshot = buildTypeSnapshot(fn, 'file:///unicode.axl');
    assert.strictEqual(snapshot.root.text, 'void f(){ string x = "日本語 😀"; }');
    assert.deepStrictEqual(snapshot.root.range.start, {line: 1, character: 0});
    // Compare every copied node to its absolute source interval, including anonymous operator fields.
    function check(node: typeof snapshot.root): void {
      assert.strictEqual(node.text, text.slice(node.start, node.end));
      node.children.forEach(check);
      Object.values(node.fields).flat().forEach(check);
    }
    check(snapshot.root);
  });

});
