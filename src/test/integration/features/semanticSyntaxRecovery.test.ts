import * as assert from 'assert';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Semantic diagnostics: syntax recovery', () => {
  const fixtures = useWorkspaceFixtures();
  function check(text: string) {
    return fixtures.createWorkspaceIndex().analyzeDocument({uri: 'file:///recovery.axl', version: 1, text}).diagnostics;
  }
  test('reports undefined names and types in an independent function', () => {
    const diagnostics = check('void broken(){ value + ; consumed; }\nvoid valid(){ DBCategory cat; DMIniF.Store(); }');
    assert.ok(diagnostics.some(d => d.message === 'Syntax error.'));
    for (const message of ["Unknown type 'DBCategory'.", "Unknown identifier 'DMIniF'."]) {
      assert.ok(diagnostics.some(d => d.message === message), JSON.stringify(diagnostics));
    }
  });
  test('reports independent statements in the same block', () => {
    const diagnostics = check('void f(){ DEBUG dat.Now(); DMIniF.Store(); DBCategory cat; }');
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'DMIniF'."));
    assert.ok(diagnostics.some(d => d.message === "Unknown type 'DBCategory'."));
    assert.ok(!diagnostics.some(d => d.message === "Unknown identifier 'dat'."));
  });
  test('does not diagnose references inside a recovered expression', () => {
    const diagnostics = check('void f(){ broken + ; consumed; }');
    assert.ok(diagnostics.some(d => d.message === 'Syntax error.'));
    assert.ok(!diagnostics.some(d => d.message.startsWith('Unknown identifier')));
  });
  test('suppresses calls depending on a broken signature but checks unrelated calls', () => {
    const diagnostics = check('void broken(int x, ???); void good(int x){} void f(){ broken(); good(); }');
    assert.ok(!diagnostics.some(d => d.message.startsWith("Function 'broken' expects")));
    assert.ok(diagnostics.some(d => d.message.startsWith("Function 'good' expects")), JSON.stringify(diagnostics));
  });
  test('limits an unrecognizable declaration to its enclosing scope', () => {
    const diagnostics = check('void damaged(){ typedef ; consumed; maybeDeclared; } void intact(){ outside; }');
    assert.ok(!diagnostics.some(d => d.message === "Unknown identifier 'maybeDeclared'."));
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'outside'."), JSON.stringify(diagnostics));
  });
  test('suppresses a scope with a missing closing brace', () => {
    const diagnostics = check('void good(){ outside; } void broken(){ inside;');
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'outside'."));
    assert.ok(!diagnostics.some(d => d.message === "Unknown identifier 'inside'."));
  });
  test('defers member diagnostics depending on a damaged class', () => {
    const diagnostics = check('class Broken { int x; ??? }; void f(Broken b){ b.missing; unrelated; }');
    assert.ok(!diagnostics.some(d => d.code === 'axel.type.member' || d.message === "Unknown identifier 'missing'."), JSON.stringify(diagnostics));
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'unrelated'."));
  });
  test('defers members inherited from a damaged class', () => {
    const diagnostics = check('class Broken { int x; ??? }; class Derived:public Broken { int y; }; void f(Derived b){ b.missing; unrelated; }');
    assert.ok(!diagnostics.some(d => d.code === 'axel.type.member' || d.message === "Unknown identifier 'missing'."));
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'unrelated'."));
  });
  test('defers member chains on functions returning a damaged class', () => {
    const diagnostics = check('class Broken { int x; ??? }; Broken make(){ Broken b; return b; } void f(){ make().missing; unrelated; }');
    assert.ok(!diagnostics.some(d => d.code === 'axel.type.member' || d.message === "Unknown identifier 'missing'."));
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'unrelated'."));
  });
  test('defers nested members whose field type is damaged', () => {
    const diagnostics = check('class Broken { int x; ??? }; class Holder { Broken value; }; void f(Holder h){ h.value.missing; unrelated; }');
    assert.ok(!diagnostics.some(d => d.code === 'axel.type.member' || d.message === "Unknown identifier 'missing'."));
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'unrelated'."));
  });
  test('does not suppress a healthy binding shadowing a damaged class name', () => {
    const diagnostics = check('class Broken { int x; ??? }; class Fine { int x; }; void f(Fine Broken){ Broken.missing; unrelated; }');
    assert.ok(diagnostics.some(d => d.code === 'axel.type.member'));
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'unrelated'."));
  });
  test('continues GUI receiver diagnostics in an independent method', () => {
    const diagnostics = check('class Dialog : public GCDialog { GCText input; }; void broken(){ DEBUG dat.Now(); } void Dialog::missing::OnChanged() {}');
    assert.ok(diagnostics.some(d => d.message === "Unknown GUI receiver path segment 'missing'."));
  });
  test('recomputes suppression after repairing and reintroducing syntax errors', () => {
    const index = fixtures.createWorkspaceIndex();
    const uri = 'file:///edits.axl';
    for (const [version, text, expected] of [
      [1, 'void f(){ broken + ; consumed; }', false],
      [2, 'void f(){ broken; consumed; }', true],
      [3, 'void f(){ broken + ; consumed; }', false]
    ] as const) {
      const diagnostics = index.analyzeDocument({uri, version, text}).diagnostics;
      assert.strictEqual(diagnostics.some(d => d.message === "Unknown identifier 'consumed'."), expected);
    }
  });
  test('suppresses an unrecoverable top-level structure', () => {
    const diagnostics = check('class Broken { int x; void f(){ missing; }');
    assert.ok(!diagnostics.some(d => d.message.startsWith('Unknown identifier')));
  });
});
