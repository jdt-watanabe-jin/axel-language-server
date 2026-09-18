import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { useWorkspaceFixtures } from '../../support/workspace';
import { positionFromOffset } from '../../support/source';
import { getDocumentHighlightsSteps } from '../../../analyzer/documentHighlights';

suite('Document highlights', () => {
  const { createWorkspaceIndex, createTempDir } = useWorkspaceFixtures();
  function fixture(text: string) {
    const index = createWorkspaceIndex();
    const uri = pathToFileURL(path.join(createTempDir(), 'main.axl')).toString();
    const analysis = index.indexOpenDocument({uri, version:1, text});
    const highlights = (name: string, occurrence = 0) => {
      let offset = -1;
      for (let i=0; i<=occurrence; i++) { offset = text.indexOf(name,offset+1); }
      assert.ok(offset >= 0);
      return runAnalysisSteps(getDocumentHighlightsSteps({analysis,position:positionFromOffset(text,offset),workspaceIndex:index}));
    };
    return {index, uri, analysis, highlights};
  }

  test('classifies declaration, assignment and reads without including a shadowed local', () => {
    const f = fixture('int value = 0;\nvoid f() { value = value + 1; { int value; value++; } }');
    assert.deepStrictEqual(f.highlights('value').map(h=>h.kind), ['write','write','read']);
    assert.deepStrictEqual(f.highlights('value',3).map(h=>h.kind), ['text','write']);
  });

  test('distinguishes arrays, pointers, members and unevaluated operands', () => {
    const f = fixture('class A { int member; };\nvoid f() { int array[3]; int *ptr; A obj; int i = 0; array[i] = *ptr; ptr[i] = 1; obj.member++; sizeof(i++); delete ptr; }');
    assert.deepStrictEqual(f.highlights('array').map(h=>h.kind), ['text','write']);
    assert.deepStrictEqual(f.highlights('ptr').map(h=>h.kind), ['text','read','read','read']);
    assert.deepStrictEqual(f.highlights('member').map(h=>h.kind), ['text','write']);
    assert.deepStrictEqual(f.highlights('obj').map(h=>h.kind), ['text','read']);
    assert.deepStrictEqual(f.highlights('i =').map(h=>h.kind), ['write','read','read','text']);
  });

  test('unifies callable declarations but not overloads or their parameters', () => {
    const f = fixture('int target(int x);\nint target(int x) { return x; }\nint target(int *x) { return 0; }\nvoid f() { int *p; target(1); target(p); }');
    assert.strictEqual(f.highlights('target').length,3);
    assert.deepStrictEqual(f.highlights('target',1),f.highlights('target'));
    assert.strictEqual(f.highlights('target',2).length,2);
    assert.strictEqual(f.highlights('x').length,1);
    assert.deepStrictEqual(f.highlights('x',1).map(h=>h.kind),['text','read']);
  });

  test('keeps only actual macro argument references and aggregates writes', () => {
    const f = fixture('#define IGNORE(a) 0\n#define STR(a) #a\n#define BUMP(a) ((a) += (a))\nint x;\nvoid f() { IGNORE(x); STR(x); BUMP(x); }');
    assert.deepStrictEqual(f.highlights('x;').map(h=>h.kind),['text','write']);
    assert.deepStrictEqual(f.highlights('x)',0),[]);
    assert.deepStrictEqual(f.highlights('x)',1),[]);
    assert.strictEqual(f.highlights('BUMP').length,2);
  });

  test('tracks evaluated macro conditions, undef and redefinitions', () => {
    const f = fixture('#define FLAG 0\n#if FLAG\nint hidden;\n#endif\n#undef FLAG\n#define FLAG 1\n#if FLAG\nint shown;\n#elif FLAG\nint hidden2;\n#endif');
    assert.strictEqual(f.highlights('FLAG').length,3);
    assert.strictEqual(f.highlights('FLAG',3).length,2);
    assert.deepStrictEqual(f.highlights('FLAG',5),[]);
  });

  test('excludes ambiguous overload value references and calls rather than picking a first candidate', () => {
    const f = fixture('void target(int x) {}\nvoid target(double x) {}\nvoid f() { target(1); target; }');
    assert.strictEqual(f.highlights('target').length,1);
    assert.deepStrictEqual(f.highlights('target',2),[]);
    assert.deepStrictEqual(f.highlights('target',3),[]);
  });

  test('handles nested expansions and distinguishes macro spelling from generated function spelling', () => {
    const f = fixture('void target(int v) {}\n#define INNER(a) target(a)\n#define OUTER(a) INNER(a)\nint x;\nvoid f() { OUTER(x); target(x); }');
    assert.strictEqual(f.highlights('target').length,2);
    assert.deepStrictEqual(f.highlights('x;').map(h=>h.kind),['text','read','read']);
    assert.strictEqual(f.highlights('OUTER').length,2);
  });

  test('excludes unresolved macro arguments instead of creating textual references', () => {
    const f = fixture('#define BAD(a,b) a + b\nint x;\nvoid f() { BAD(x); }');
    assert.strictEqual(f.highlights('x;').length,1);
    assert.deepStrictEqual(f.highlights('x)'),[]);
  });

  test('non-evaluated conditions and macro formal parameters are not occurrences', () => {
    const f = fixture('#define FLAG 0\n#define PICK(FLAG) FLAG\n#if FLAG\n#if FLAG\nint hidden;\n#endif\n#endif\nint FLAGGED;');
    assert.strictEqual(f.highlights('FLAG').length,2);
    assert.deepStrictEqual(f.highlights('FLAG',1),[]);
    assert.deepStrictEqual(f.highlights('FLAG',4),[]);
  });

  test('resolves implicit members before globals in out-of-class bodies and inherited methods', () => {
    const f = fixture('int value; class A { int value; void f(); }; void A::f() { value++; }');
    assert.strictEqual(f.highlights('value').length,1);
    assert.deepStrictEqual(f.highlights('value',1).map(h=>h.kind),['text','write']);
    const inherited = fixture('class Base { int value; }; class A : public Base { void f() { value++; } };');
    assert.deepStrictEqual(inherited.highlights('value').map(h=>h.kind),['text','write']);
    const later = fixture('class A { void f() { value++; } int value; };');
    assert.deepStrictEqual(later.highlights('value').map(h=>h.kind),['write','text']);
  });

  test('resolves member storage through expression receivers', () => {
    const f = fixture('class A { int value; }; A factory() { A a; return a; } void f() { A items[2]; items[0].value++; factory().value = 1; }');
    assert.deepStrictEqual(f.highlights('value').map(h=>h.kind),['text','write','write']);
  });

  test('does not merge multiple definitions that merely share a callable signature', () => {
    const f = fixture('void target() {} void target() {} void f() { target(); }');
    assert.strictEqual(f.highlights('target').length,1);
    assert.strictEqual(f.highlights('target',1).length,1);
    assert.deepStrictEqual(f.highlights('target',2),[]);
  });

  test('does not highlight macro names used only in unused or stringified arguments', () => {
    for (const replacement of ['0','#a','a##tail']) {
      const f = fixture(`#define OUTER(a) ${replacement}\n#define VALUE 1\nvoid f() { OUTER(VALUE); }`);
      assert.strictEqual(f.highlights('VALUE').length,1);
      assert.deepStrictEqual(f.highlights('VALUE',1),[]);
    }
  });

  test('keeps actually expanded macro names inside used arguments including empty output', () => {
    const f = fixture('#define ID(a) a\n#define VALUE 1\n#define INNER() 2\n#define EMPTY()\nvoid f() { ID(VALUE); ID(INNER()); ID(EMPTY()); }');
    for (const name of ['VALUE','INNER','EMPTY']) { assert.strictEqual(f.highlights(name).length,2,name); }
    const unused = fixture('#define DROP(a) 0\n#define INNER() 1\nvoid f() { DROP(INNER()); }');
    assert.strictEqual(unused.highlights('INNER').length,1);
  });
});
