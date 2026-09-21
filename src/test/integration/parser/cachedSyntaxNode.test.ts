import * as assert from 'assert';
import type * as Parser from 'tree-sitter';
import { createAxelParser } from '../../../analyzer/axelParser';
import { cachedSyntaxNode } from '../../../analyzer/cachedSyntaxNode';
import { buildSymbolIndex } from '../../../analyzer/symbolIndex';

suite('Parse-local syntax reads', () => {
  test('reuses an already enumerated child array', () => {
    const root = createAxelParser().parse('int x; void f(){ x = 1; }').rootNode;
    const children = root.children;
    let reads = 0;
    Object.defineProperty(root, 'namedChildren', { configurable: true,
      get: () => { reads++; return children.filter(child => child.isNamed); } });
    const view = cachedSyntaxNode(root);
    const all = view.children;
    assert.deepStrictEqual(view.namedChildren, all.filter(child => child.isNamed));
    assert.strictEqual(reads, 0);
  });
  test('reuses indexed children only for valid integer indices in an enumerated array', () => {
    const root = createAxelParser().parse('int x; int y;').rootNode;
    const native = root.child.bind(root);
    let reads = 0;
    Object.defineProperty(root, 'child', { configurable: true, value: (i: number) => { reads++; return native(i); } });
    const view = cachedSyntaxNode(root);
    assert.strictEqual(view.child(0)?.id, view.children[0].id);
    const before = reads;
    assert.strictEqual(view.child(1)?.id, view.children[1].id);
    assert.strictEqual(reads, before);
    for (const i of [-1, 0.5, 999]) {
      let expected: Parser.SyntaxNode | null | undefined;
      try { expected = native(i); } catch { assert.throws(() => view.child(i)); continue; }
      assert.strictEqual(view.child(i)?.id, expected?.id);
    }
  });
  for (const text of ['int x; void f(){ x = 1; }', 'void f(){ f(1,', '/* doc */ string s = "";', 'class C { int x; };']) {
    for (const namedFirst of [false, true]) {
      test(`preserves native children, fields and recovery (${namedFirst}, ${text})`, () => {
        const root = createAxelParser().parse(text).rootNode;
        const view = cachedSyntaxNode(root);
        function check(native: Parser.SyntaxNode, cached: Parser.SyntaxNode): void {
          if (namedFirst) { assert.deepStrictEqual(cached.namedChildren.map(n => n.id), native.namedChildren.map(n => n.id)); }
          assert.deepStrictEqual(cached.children.map(n => n.id), native.children.map(n => n.id));
          assert.deepStrictEqual(cached.namedChildren.map(n => n.id), native.namedChildren.map(n => n.id));
          assert.deepStrictEqual(cached.startPosition, native.startPosition);
          assert.deepStrictEqual(cached.endPosition, native.endPosition);
          assert.strictEqual(cached.isMissing, native.isMissing);
          assert.strictEqual(cached.parent?.id, native.parent?.id);
          for (let i = 0; i < native.childCount; i++) {
            assert.strictEqual(cached.fieldNameForChild(i), native.fieldNameForChild(i));
            check(native.child(i)!, cached.child(i)!);
          }
        }
        check(root, view);
        for (const types of ['identifier', ['identifier', 'comment']]) {
          assert.deepStrictEqual(view.descendantsOfType(types).map(n => n.id), root.descendantsOfType(types).map(n => n.id));
        }
      });
    }
  }
  test('does not scan every child of a translation unit for nonexistent declarators', () => {
    const root = createAxelParser().parse('int first; int second; void f(){ first = second; }').rootNode;
    const child = root.child.bind(root);
    let childReads = 0;
    Object.defineProperty(root, 'child', { value: (index: number) => { childReads++; return child(index); }, configurable: true });
    const symbols = buildSymbolIndex(cachedSyntaxNode(root), 'file:///main.axl');
    assert.deepStrictEqual(symbols.declarations.map(d => d.name), ['first', 'second', 'f']);
    assert.ok(symbols.references.some(r => r.name === 'first'));
    assert.strictEqual(childReads, 0, 'Translation units have no declarator field; indexed child lookup is unnecessary');
  });

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
      assert.strictEqual(namedReads, 0, 'named children can use the already enumerated children');
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
