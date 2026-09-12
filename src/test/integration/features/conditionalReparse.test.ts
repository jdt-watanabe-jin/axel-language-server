import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Conditional source reparse', () => {
  const fixtures = useWorkspaceFixtures();
  const body = `void f(){
#ifndef NO_ESPQ
if (1) {
#else
if (0) {
#endif
int local = 1;
}
missingValue;
}`;
  for (const defines of [[], ['NO_ESPQ=1']]) {
    test('balances split braces with '+JSON.stringify(defines), () => {
      const a = fixtures.createWorkspaceIndex({defines}).analyzeDocument({uri:'file:///split.axl',version:1,text:body});
      assert.ok(!a.diagnostics.some(d => d.message === 'Syntax error.'), JSON.stringify(a.diagnostics));
      assert.ok(a.declarations.some(d => d.name === 'local'));
      const d = a.diagnostics.find(d => d.message === "Unknown identifier 'missingValue'.")!;
      assert.ok(d);
      assert.deepStrictEqual(d.range.start, {line:8,character:0});
    });
  }
  test('discards an inactive outer block before parsing its braces', () => {
    const text = '#if __APP_CCUBE__\n'+body+'\n#endif\nvoid after() {}';
    const a = fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///inactive.axl',version:1,text});
    assert.deepStrictEqual(a.diagnostics, []);
    assert.ok(a.declarations.some(d => d.name === 'after'));
    assert.ok(!a.declarations.some(d => d.name === 'local'));
    assert.ok(a.inactiveRanges!.length > 0);
  });
  test('retains actual syntax errors in the selected branch', () => {
    const a = fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///invalid.axl',version:1,text:body.replace('int local = 1;', 'int local = ;')});
    assert.ok(a.diagnostics.some(d => d.message === 'Syntax error.'));
  });
  test('does not guess an uncertain branch', () => {
    const a = fixtures.createWorkspaceIndex({defines:['MAYBE=unknown']}).analyzeDocument({uri:'file:///uncertain.axl',version:1,text:body.replace('#ifndef NO_ESPQ','#if MAYBE')});
    assert.ok(a.diagnostics.some(d => d.message === 'Syntax error.'));
  });
  test('ignores directive-like text in strings and block comments with CRLF', () => {
    const text = ('/*\n#if BROKEN\n#endif\n*/\n' + body.replace('missingValue;', '"#endif"; missingValue;')).replace(/\n/g, '\r\n');
    const a = fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///trivia.axl',version:1,text});
    assert.ok(!a.diagnostics.some(d => d.message === 'Syntax error.'));
    assert.strictEqual(a.diagnostics.find(d => d.message === "Unknown identifier 'missingValue'.")?.range.start.line, 12);
  });
  test('respects source defines and undef in directive order', () => {
    const text = '#define NO_ESPQ 1\n#undef NO_ESPQ\n' + body.replace('if (0) {','if (0) { invalid_inactive;');
    const a = fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///defines.axl',version:1,text});
    assert.ok(!a.diagnostics.some(d => d.message === 'Syntax error.' || d.message.includes('invalid_inactive')));
    assert.ok(a.diagnostics.some(d => d.message === "Unknown identifier 'missingValue'."));
  });
  test('recovers known branches alongside unrelated uncertain declarations', () => {
    const text = '#if MAYBE\nint uncertain;\n#endif\n'+body;
    const a = fixtures.createWorkspaceIndex({defines:['MAYBE=unknown']}).analyzeDocument({uri:'file:///mixed.axl',version:1,text});
    assert.ok(!a.diagnostics.some(d => d.message === 'Syntax error.'));
    assert.ok(a.diagnostics.some(d => d.message === "Unknown identifier 'missingValue'."));
  });

  test('uses included definitions at their source position', () => {
    const root = fixtures.createTempDir();
    fs.writeFileSync(path.join(root, 'flags.h'), '#define NO_ESPQ 1\n');
    const text = '#include "flags.h"\n'+body.replace('if (1) {', 'if (1) { inactive_name;');
    const a = fixtures.createWorkspaceIndex().analyzeDocument({uri:pathToFileURL(path.join(root,'main.axl')).toString(),version:1,text});
    assert.ok(!a.diagnostics.some(d => d.message === 'Syntax error.' || d.message.includes('inactive_name')));
    assert.ok(a.diagnostics.some(d => d.message === "Unknown identifier 'missingValue'."));
  });
  test('retains macro expansion after branch selection', () => {
    const text = '#define VALUE 1\n'+body.replace('int local = 1;', 'int local = VALUE;');
    const a = fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///macro.axl',version:1,text});
    assert.ok(!a.diagnostics.some(d => d.message === 'Syntax error.' || d.message.includes("identifier 'VALUE'")));
    assert.ok(a.diagnostics.some(d => d.message === "Unknown identifier 'missingValue'."));
    assert.ok(a.inactiveRanges!.length > 0);
  });
  test('does not hide malformed conditional directives', () => {
    const text = body.replace('#endif', '');
    const a = fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///malformed.axl',version:1,text});
    assert.ok(a.diagnostics.some(d => d.message === 'Syntax error.' || d.message.startsWith('Missing')));
  });

});
