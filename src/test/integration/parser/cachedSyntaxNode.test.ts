import * as assert from 'assert';
import type * as Parser from 'tree-sitter';
import { createAxelParser } from '../../../analyzer/axelParser';
import { cachedSyntaxNode } from '../../../analyzer/cachedSyntaxNode';

suite('Parse-local syntax reads', () => {
  test('does not enumerate native child arrays when their count is zero', () => {
    const root = createAxelParser().parse('int value; string empty = "";').rootNode;
    const leaf = root.descendantsOfType('identifier')[0];
    const emptyString = root.descendantsOfType('string_literal')[0];
    for (const node of [leaf, emptyString]) {
      const expectedChildren = node.children;
      const expectedNamedChildren = node.namedChildren;
      let childrenReads = 0, namedReads = 0;
      Object.defineProperty(node,'children',{get:()=>{childrenReads++;return expectedChildren;},configurable:true});
      Object.defineProperty(node,'namedChildren',{get:()=>{namedReads++;return expectedNamedChildren;},configurable:true});
      const view = cachedSyntaxNode(node);
      assert.deepStrictEqual(view.children.map(child => child.id), expectedChildren.map(child => child.id));
      assert.deepStrictEqual(view.namedChildren.map(child => child.id), expectedNamedChildren.map(child => child.id));
      assert.strictEqual(childrenReads, node.childCount === 0 ? 0 : 1);
      assert.strictEqual(namedReads, node.namedChildCount === 0 ? 0 : 1);
    }
  });
  test('does not repeat native child reads for multiple analysis passes', () => {
    const root = createAxelParser().parse('void f(){ int x=1; }').rootNode;
    let reads=0;
    const children=root.namedChildren;
    Object.defineProperty(root,'namedChildren',{get:()=>{reads++;return children;},configurable:true});
    const view=cachedSyntaxNode(root);
    for(let i=0;i<20;i++) { assert.strictEqual(view.namedChildren[0].type,'function_definition'); }
    assert.strictEqual(reads,1);
  });
  test('keeps independent method arguments and bounded descendant queries cached', () => {
    const root = createAxelParser().parse('int first;\nstring second;').rootNode;
    const view = cachedSyntaxNode(root);
    for (let pass = 0; pass < 3; pass++) {
      for (let index = 0; index <= root.childCount; index++) {
        assert.strictEqual(view.child(index)?.id, root.child(index)?.id);
        assert.strictEqual(view.namedChild(index)?.id, root.namedChild(index)?.id);
        assert.strictEqual(view.fieldNameForChild(index), root.fieldNameForChild(index));
      }
      for (const name of ['type', 'declarator', 'missing']) {
        assert.strictEqual(view.child(0)!.childForFieldName(name)?.id, root.child(0)!.childForFieldName(name)?.id);
      }
      for (const row of [0, 1]) {
        const start = { row, column: 0 };
        const end = { row, column: 30 };
        assert.deepStrictEqual(view.descendantsOfType('identifier', start, end).map(node => node.text),
          root.descendantsOfType('identifier', start, end).map(node => node.text));
      }
    }
    assert.strictEqual(view.child(0), view.namedChildren[0]);
  });
  test('preserves node fields, positions and parent identities', () => {
    const root=createAxelParser().parse('class C { int x; virtual void f(int ...); }; void g(){ C *p; p->x=1; }').rootNode;
    const view=cachedSyntaxNode(root);
    function check(a:Parser.SyntaxNode,b:Parser.SyntaxNode) {
      assert.strictEqual(a.type,b.type); assert.strictEqual(a.text,b.text);
      assert.deepStrictEqual(a.startPosition,b.startPosition); assert.deepStrictEqual(a.endPosition,b.endPosition);
      assert.strictEqual(a.hasError,b.hasError); assert.strictEqual(a.isNamed,b.isNamed);
      assert.strictEqual(a.childCount,b.childCount);
      for(let i=0;i<a.childCount;i++) {
        assert.strictEqual(a.fieldNameForChild(i),b.fieldNameForChild(i));
        const field=a.fieldNameForChild(i);
        if(field) { assert.strictEqual(a.childForFieldName(field)?.id,b.childForFieldName(field)?.id); }
        const child=b.child(i)!;
        assert.strictEqual(child.parent?.id,b.id);
        check(a.child(i)!,child);
      }
    }
    check(root,view);
    assert.deepStrictEqual(view.descendantsOfType('function_definition').map(n=>n.text),root.descendantsOfType('function_definition').map(n=>n.text));
  });
  test('isolates separately parsed document versions', () => {
    const parser=createAxelParser();
    const before=cachedSyntaxNode(parser.parse('int before;').rootNode);
    const after=cachedSyntaxNode(parser.parse('int after;').rootNode);
    assert.ok(before.namedChildren[0].text.includes('before'));
    assert.ok(after.namedChildren[0].text.includes('after'));
  });
});
