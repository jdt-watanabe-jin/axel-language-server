import * as assert from 'assert';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Pointer dot member access', () => {
  const fixtures = useWorkspaceFixtures();
  function check(body: string) {
    return fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///pointer-dot.axl',version:1,
      text:`class Item { int x; int GetTextAt(int index) { return 1; } }; void f(Item *p, Item value) { ${body} }`});
  }
  test('resolves a method and warns on the dot', () => {
    const a = check('int s = p.GetTextAt(0);');
    assert.strictEqual(a.diagnostics.length, 1);
    const d = a.diagnostics[0];
    assert.strictEqual(d.severity, 'warning');
    assert.strictEqual(d.code, 'axel.type.pointer_dot');
    assert.strictEqual(d.range.end.character - d.range.start.character, 1);
    assert.ok(d.message.includes("->"));
  });
  test('accepts arrow access and ordinary object dot access', () => {
    assert.deepStrictEqual(check('int s = p->GetTextAt(0); s = value.GetTextAt(0);').diagnostics, []);
  });
  test('preserves field storage and method return types', () => {
    const a = check('p.x = 1; int *bad = p.GetTextAt(0);');
    assert.strictEqual(a.diagnostics.filter(d => d.code === 'axel.type.pointer_dot').length, 2);
    assert.ok(a.diagnostics.some(d => d.severity === 'error'));
    assert.ok(!a.diagnostics.some(d => d.code === 'axel.type.member'));
  });
  test('still diagnoses a missing member', () => {
    assert.ok(check('p.Missing();').diagnostics.some(d => d.code === 'axel.type.member' && d.severity === 'error'));
  });
});
