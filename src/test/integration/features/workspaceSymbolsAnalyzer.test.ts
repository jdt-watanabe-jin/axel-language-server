import * as assert from 'assert';
import { CancellationToken } from 'vscode-languageserver/node';
import { extractWorkspaceSymbols } from '../../../analyzer/workspaceSymbols/extract';
suite('Workspace Symbol analyzer', () => {
  const extract = (text: string) => extractWorkspaceSymbols({ uri: 'file:///main.axl', version: 1, text }, CancellationToken.None);
  test('excludes inactive code, parameters and local declarations while retaining physical locations', async () => {
    const entries = await extract('#if 0\nint hidden;\n#endif\nint global;\nint run(int argument){int local; return 0;}');
    assert.deepStrictEqual(entries.map(x => x.name), ['global', 'run']);
    assert.deepStrictEqual(entries[0].selectionRange.start, { line: 3, character: 4 });
  });
  test('retains declarations, definitions, overloads, fields and enum members', async () => {
    const entries = await extract('class Version { int field; void make(); };\nvoid Version::make() {}\nvoid Version::make(int n) {}\nenum Mode { A, B };');
    assert.deepStrictEqual(entries.filter(x => x.name === 'make').map(x => [x.qualifiedName, x.selectionRange.start.line]),
      [['Version::make', 0], ['Version::make', 1], ['Version::make', 2]]);
    assert.ok(entries.some(x => x.qualifiedName === 'Version::field'));
    assert.ok(entries.some(x => x.name === 'B' && x.kind === 'enumMember'));
  });
  test('retains unknown include branches including GUI parts and excludes known false branches', async () => {
    const entries = await extract('#include "unknown.h"\n#ifdef FEATURE\nclass dialog : public GCDialog { GCCheckBox One; };\n#else\nint fallback;\n#endif\n#undef FEATURE\n#ifdef FEATURE\nint disabled;\n#endif');
    assert.ok(entries.some(x => x.name === 'One'));
    assert.ok(entries.some(x => x.name === 'fallback'));
    assert.ok(!entries.some(x => x.name === 'disabled' || x.kind === 'include'));
  });
  test('preserves GUI event hierarchy and unowned method navigation', async () => {
    const entries = await extract('class dialog : public GCDialog { GCControlButton button { OnCreate() {} }; };\nvoid Version::reset() {}');
    assert.ok(entries.some(x => x.name === 'OnCreate' && x.containerName?.includes('button')));
    assert.deepStrictEqual(entries.find(x => x.name === 'reset')?.selectionRange.start, { line: 1, character: 14 });
  });
  test('does not generate virtual declarations from macros and retains recoverable syntax', async () => {
    const entries = await extract('#define DECL int virtualName;\nDECL\nint *;\nint good;');
    assert.ok(entries.some(x => x.name === 'DECL' && x.kind === 'macro'));
    assert.ok(entries.some(x => x.name === 'good'));
    assert.ok(!entries.some(x => x.name === 'virtualName'));
  });
  test('retains every declarator in global and field declarations', async () => {
    const entries = await extract('int first, second; class C { int x,y; };');
    assert.deepStrictEqual(entries.map(x => x.name), ['first', 'second', 'C', 'x', 'y']);
    assert.strictEqual(entries.find(x => x.name === 'second')?.selectionRange.start.character, 11);
  });
  test('retains both possible elifdef alternatives after unknown includes', async () => {
    const entries = await extract('#include "unknown.h"\n#if 0\nint a;\n#elifdef FEATURE\nint b;\n#else\nint c;\n#endif');
    assert.deepStrictEqual(entries.map(x => x.name), ['b', 'c']);
  });
  test('selects only the member token in multiline external definitions', async () => {
    const entries = await extract('void Version::\nreset() {}');
    assert.deepStrictEqual(entries.map(x => [x.name, x.qualifiedName, x.selectionRange]), [['reset', 'Version::reset',
      { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }]]);
  });
  test('keeps active GUI handlers when their owner or receiver is inactive', async () => {
    for (const text of [
      '#if 0\nclass Dialog : public GCDialog { GCText item; };\n#endif\nvoid Dialog::item::OnCreate() {}',
      'class Dialog : public GCDialog {\n#if 0\nGCText item;\n#endif\n};\nvoid Dialog::item::OnCreate() {}'
    ]) {
      const entries = await extract(text);
      assert.ok(entries.some(x => x.name === 'OnCreate' && x.containerName === 'Dialog::item'));
      assert.ok(!entries.some(x => x.name === 'item'));
    }
  });
  test('uses AXEL receiver paths for nested GUI parts and handlers', async () => {
    const entries = await extract('class D : public GCDialog { GCGroupBox box { GCCheckBox Two; }; };\nvoid D::box.Two::OnChanged() {}');
    assert.strictEqual(entries.find(x => x.name === 'Two')?.qualifiedName, 'D::box.Two');
    assert.strictEqual(entries.find(x => x.name === 'OnChanged')?.qualifiedName, 'D::box.Two::OnChanged');
  });
});
