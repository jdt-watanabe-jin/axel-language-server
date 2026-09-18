import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getDocumentHighlightsSteps } from '../../../analyzer/documentHighlights';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Document highlight edges', () => {
  const { createWorkspaceIndex, createTempDir } = useWorkspaceFixtures();

  function fixture(initialText: string, headers: Record<string, string> = {}) {
    const directory = createTempDir();
    for (const [name, content] of Object.entries(headers)) {
      fs.writeFileSync(path.join(directory, name), content);
    }
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const index = createWorkspaceIndex();
    let text = initialText;
    let version = 1;
    let analysis = index.indexOpenDocument({ uri, version, text });
    const at = (offset: number) => runAnalysisSteps(getDocumentHighlightsSteps({
      analysis, position: positionFromOffset(text, offset), workspaceIndex: index
    }));
    return {
      at,
      named(name: string, occurrence = 0) {
        let offset = -1;
        for (let n = 0; n <= occurrence; n++) { offset = text.indexOf(name, offset + 1); }
        assert.ok(offset >= 0, `Missing occurrence ${occurrence} of ${name}`);
        return at(offset);
      },
      update(updated: string) {
        text = updated;
        analysis = index.indexOpenDocument({ uri, version: ++version, text });
      },
      expected(name: string, occurrences: number[]) {
        const positions: number[] = [];
        for (let offset = text.indexOf(name); offset >= 0; offset = text.indexOf(name, offset + 1)) {
          positions.push(offset);
        }
        return occurrences.map(n => ({
          start: positionFromOffset(text, positions[n]),
          end: positionFromOffset(text, positions[n] + name.length)
        }));
      }
    };
  }

  test('included declarations resolve while results contain only local ranges', () => {
    const f = fixture('#include "types.h"\nExternal first; External second;\nvoid main() { shared = shared + 1; }', {
      'types.h': 'class External {};\nint shared;'
    });
    assert.deepStrictEqual(f.named('External').map(h => h.range), f.expected('External', [0, 1]));
    assert.deepStrictEqual(f.named('shared').map(h => h.kind), ['write', 'read']);
    assert.deepStrictEqual(f.named('shared').map(h => h.range), f.expected('shared', [0, 1]));
    assert.deepStrictEqual(f.named('types.h'), []);
  });

  test('type aliases are distinct from their underlying class', () => {
    const f = fixture('class Original {}; typedef Original Alias; Original a; Alias b;');
    assert.deepStrictEqual(f.named('Original').map(h => h.range), f.expected('Original', [0, 1, 2]));
    assert.deepStrictEqual(f.named('Alias').map(h => h.range), f.expected('Alias', [0, 1]));
    assert.deepStrictEqual(f.named('Alias').map(h => h.kind), ['text', 'text']);
  });

  test('enumerators are declared as text and referenced as reads', () => {
    const f = fixture('enum Color { Red, Blue }; Color c; void main() { c = Red; c = Blue; }');
    assert.deepStrictEqual(f.named('Red').map(h => h.kind), ['text', 'read']);
    assert.deepStrictEqual(f.named('Color').map(h => h.kind), ['text', 'text']);
  });

  test('same named fields in different classes remain separate', () => {
    const f = fixture('class A { int value; }; class B { int value; }; void main() { A a; B b; a.value = 1; b.value = 2; }');
    assert.deepStrictEqual(f.named('value').map(h => h.range), f.expected('value', [0, 2]));
    assert.deepStrictEqual(f.named('value', 1).map(h => h.range), f.expected('value', [1, 3]));
  });

  test('base and overriding methods follow static receiver types', () => {
    const f = fixture('class Base { virtual void work() {} }; class Derived : public Base { void work() {} }; void main() { Base b; Derived d; b.work(); d.work(); }');
    assert.deepStrictEqual(f.named('work').map(h => h.range), f.expected('work', [0, 2]));
    assert.deepStrictEqual(f.named('work', 1).map(h => h.range), f.expected('work', [1, 3]));
  });

  test('qualified names highlight only the selected component', () => {
    const f = fixture('class A { static int value; }; void main() { int result = A::value; }');
    assert.deepStrictEqual(f.named('A').map(h => h.range), f.expected('A', [0, 1]));
    assert.deepStrictEqual(f.named('value').map(h => h.kind), ['text', 'read']);
    assert.deepStrictEqual(f.named('value').map(h => h.range), f.expected('value', [0, 1]));
  });

  test('qualified static member assignments are writes', () => {
    const f = fixture('class A { static int value; }; void main() { A::value = 1; A::value += 2; }');
    assert.deepStrictEqual(f.named('value').map(h => h.kind), ['text', 'write', 'write']);
  });

  test('implicit GUI properties resolve to their containing part', () => {
    const f = fixture('class GCLabel { string text; }; class Dialog : public GCDialog { GCLabel { OnCreate() { text = "label"; } }; };');
    assert.deepStrictEqual(f.named('text').map(h => h.kind), ['text', 'write']);
    assert.deepStrictEqual(f.named('text', 1), f.named('text'));
  });

  test('function pointer invocation reads the pointer variable', () => {
    const f = fixture('void target() {} void main() { void (*callback)() = target; callback(); (*callback)(); }');
    assert.deepStrictEqual(f.named('callback').map(h => h.kind), ['write', 'read', 'read']);
    assert.deepStrictEqual(f.named('target').map(h => h.kind), ['text', 'text']);
  });

  test('cursor fallback stops at the identifier end and never crosses whitespace', () => {
    const text = 'int value;\nvoid main() { value  = 1; }';
    const f = fixture(text);
    const start = text.lastIndexOf('value');
    const expected = f.at(start);
    assert.strictEqual(expected.length, 2);
    assert.deepStrictEqual(f.at(start + 4), expected);
    assert.deepStrictEqual(f.at(start + 5), expected);
    assert.deepStrictEqual(f.at(start + 6), []);
    assert.deepStrictEqual(f.at(text.indexOf('\n') + 1), []);
  });

  test('comments strings and inactive uses are excluded as origins and results', () => {
    const f = fixture('int value; // value\nvoid main() { string s = "value"; value++; }\n#if 0\nvalue++;\n#endif');
    assert.deepStrictEqual(f.named('value').map(h => h.range), f.expected('value', [0, 3]));
    for (const occurrence of [1, 2, 4]) { assert.deepStrictEqual(f.named('value', occurrence), []); }
  });

  test('unsaved replacement invalidates previous names and positions', () => {
    const f = fixture('int value; void main() { value++; }');
    assert.strictEqual(f.named('value').length, 2);
    f.update('// new unsaved line\nint replacement; void main() { replacement++; value++; }');
    assert.deepStrictEqual(f.named('replacement').map(h => h.range), f.expected('replacement', [0, 1]));
    assert.deepStrictEqual(f.named('value'), []);
  });

  for (const newline of ['\n', '\r\n']) {
    test(`Japanese and surrogate pairs preserve UTF-16 positions with ${JSON.stringify(newline)}`, () => {
      const f = fixture(['int value;', 'void main() { /* 日本語😀 */ value++; }'].join(newline));
      assert.deepStrictEqual(f.named('value', 1).map(h => h.range), f.expected('value', [0, 1]));
    });
  }

  test('duplicate global declarations do not choose the first reference candidate', () => {
    const f = fixture('int repeated; int repeated; void main() { repeated++; }');
    assert.deepStrictEqual(f.named('repeated', 2), []);
    assert.deepStrictEqual(f.named('repeated').map(h => h.range), f.expected('repeated', [0]));
    assert.deepStrictEqual(f.named('repeated', 1).map(h => h.range), f.expected('repeated', [1]));
  });

  test('independent valid references survive an incomplete following function', () => {
    const f = fixture('int value; void main() { value++; }\nvoid incomplete(');
    assert.deepStrictEqual(f.named('value').map(h => h.kind), ['text', 'write']);
    assert.deepStrictEqual(f.named('value').map(h => h.range), f.expected('value', [0, 1]));
  });

  test('a derived receiver resolves an inherited field without merging hidden fields', () => {
    const f = fixture('class Base { int field; }; class Derived : public Base {}; class Hidden : public Base { int field; }; void main() { Derived d; Hidden h; d.field++; h.field++; }');
    assert.deepStrictEqual(f.named('field').map(h => h.range), f.expected('field', [0, 2]));
    assert.deepStrictEqual(f.named('field', 1).map(h => h.range), f.expected('field', [1, 3]));
  });

  test('ambiguous imported globals are excluded regardless of include ordering', () => {
    for (const names of [['first.h', 'second.h'], ['second.h', 'first.h']]) {
      const f = fixture(names.map(name => `#include "${name}"`).join('\n') + '\nvoid main() { ambiguous++; }', {
        'first.h': 'int ambiguous;', 'second.h': 'int ambiguous;'
      });
      assert.deepStrictEqual(f.named('ambiguous'), []);
    }
  });
});
