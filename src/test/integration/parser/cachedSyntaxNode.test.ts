import * as assert from 'assert';
import type * as Parser from 'tree-sitter';
import { createAxelParser } from '../../../analyzer/axelParser';
import { cachedSyntaxNode } from '../../../analyzer/cachedSyntaxNode';

suite('Parse-local syntax reads', () => {
  test('does not repeat native child reads for multiple analysis passes', () => {
    const root = createAxelParser().parse('void f(){ int x=1; }').rootNode;
    let reads=0;
    const children=root.namedChildren;
    Object.defineProperty(root,'namedChildren',{get:()=>{reads++;return children;},configurable:true});
    const view=cachedSyntaxNode(root);
    for(let i=0;i<20;i++) { assert.strictEqual(view.namedChildren[0].type,'function_definition'); }
    assert.strictEqual(reads,1);
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
