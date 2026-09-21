import * as assert from 'assert';
import { createAxelParser } from '../../analyzer/axelParser';
import { buildTypeSnapshot } from '../../analyzer/typeChecking/syntax';
suite('Syntax snapshot traversal',()=>{
  test('does not query fields of a fieldless translation unit or read every child text natively', () => {
    const root = createAxelParser().parse('int first; int second;').rootNode;
    let fields = 0, texts = 0;
    const field = root.fieldNameForChild.bind(root);
    Object.defineProperty(root, 'fieldNameForChild', { configurable: true,
      value: (index: number) => { fields++; return field(index); } });
    for (const child of root.namedChildren) {
      const text = child.text;
      Object.defineProperty(child, 'text', { configurable: true, get: () => { texts++; return text; } });
    }
    const snapshot = buildTypeSnapshot(root, 'file:///fields.axl');
    assert.deepStrictEqual(snapshot.root.children.map(child => child.text), ['int first;', 'int second;']);
    assert.strictEqual(fields, 0);
    assert.strictEqual(texts, 0);
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
  test('enumerates siblings together instead of crossing into the parser for every child',()=>{
    const root=createAxelParser().parse('int first; int second; void f(){first=second;}').rootNode;
    const child=root.child.bind(root);let indexedReads=0;
    Object.defineProperty(root,'child',{value:(index:number)=>{indexedReads++;return child(index);},configurable:true});
    const snapshot=buildTypeSnapshot(root,'file:///snapshot.axl');
    assert.strictEqual(snapshot.root.children.length,3);
    assert.strictEqual(snapshot.root.children[0].fields.declarator[0].text,'first');
    assert.strictEqual(indexedReads,0);
  });
});
