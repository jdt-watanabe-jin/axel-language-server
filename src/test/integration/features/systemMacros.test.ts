import * as assert from 'assert';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import { getHover } from '../../../analyzer/hover';
import { getCompletions } from '../../../analyzer/completion';
import { collectSemanticTokens } from '../../../analyzer/semanticTokens';
import { getDefinitions } from '../../../analyzer/navigation';
import { prepareRename } from '../../../analyzer/rename';
import { positionFromOffset } from '../../support/source';

suite('system macros', () => {
  const uri = 'file:///D:/project/main.axl';
  function fixture(text: string, tool = 'axel') {
    const index = new WorkspaceIndex();
    index.configure({ tool });
    const analysis = index.analyzeDocument({ uri, version: 1, text });
    const at = (name: string) => ({ analysis, workspaceIndex: index, position: positionFromOffset(text, text.lastIndexOf(name)) });
    return { index, analysis, at };
  }
  test('does not diagnose undefined identifiers in preprocessor conditions', () => {
    const text='#if __APP_LEDIT__\nint a;\n#elif undefinedFlag + 1\nint b;\n#endif\n#ifdef absent\nint c;\n#endif\n#ifndef otherAbsent\nint d;\n#endif';
    const {analysis}=fixture(text);
    assert.deepStrictEqual(analysis.diagnostics,[]);
    assert.ok(analysis.declarations.some(d=>d.name==='b'));
  });
  test('still diagnoses unknown identifiers in active conditional bodies', () => {
    const text='#if 1\nvoid f(){ __APP_LEDIT__; missingValue; }\n#endif';
    const {analysis}=fixture(text);
    assert.ok(analysis.diagnostics.some(d=>d.message=== "Unknown identifier '__APP_LEDIT__'."));
    assert.ok(analysis.diagnostics.some(d=>d.message=== "Unknown identifier 'missingValue'."));
  });
  test('shows absolute file and one-based source line', () => {
    const { at } = fixture('string file = __FILE__;\nint line = __LINE__;');
    assert.ok(getHover(at('__FILE__'))?.plainText.includes('D:\\project\\main.axl'));
    assert.ok(getHover(at('__LINE__'))?.plainText.includes('2'));
  });
  test('keeps runtime values symbolic and recognizes macros as tokens', () => {
    const { at, analysis } = fixture('string date = __DATE__; string time = __TIME__; string stamp = __TIMESTAMP__;');
    for (const name of ['__DATE__', '__TIME__', '__TIMESTAMP__']) {
      assert.ok(getHover(at(name))?.plainText.includes('runtime'));
    }
    assert.strictEqual(analysis.diagnostics.length, 0);
    assert.strictEqual(collectSemanticTokens(analysis).filter(t => t.tokenType === 'macro').length, 3);
    assert.deepStrictEqual(getDefinitions(at('__DATE__')), []);
    assert.strictEqual(prepareRename(at('__DATE__')), null);
  });
  test('switches tool macros without changing document version', () => {
    const text = '#ifdef __APP_LEDIT__\nint ledit;\n#else\nint other;\n#endif\nint x = __APP_LEDIT__;';
    const { index, analysis } = fixture(text, 'ismo');
    assert.ok(analysis.declarations.some(d => d.name === 'ledit'));
    assert.ok(!analysis.declarations.some(d => d.name === 'other'));
    index.configure({ tool: 'axel' });
    const changed = index.analyzeDocument({ uri, version: 1, text });
    assert.ok(changed.declarations.some(d => d.name === 'other'));
    assert.ok(changed.diagnostics.some(d => d.message.includes('__APP_LEDIT__')));
  });
  test('completes only enabled names and excludes comments and strings', () => {
    for (const text of ['void f(){ __ }', 'void f(){ "__"; }', 'void f(){ /* __ */ }', 'void f(){ // __', 'void f(){ "__']) {
      const { analysis, index } = fixture(text, 'asca');
      const items = getCompletions({ analysis, workspaceIndex: index, text, position: positionFromOffset(text, text.indexOf('__') + 2) });
      const names = items.filter(i => i.name.startsWith('__')).map(i => i.name);
      if (text === 'void f(){ __ }') {
        assert.ok(names.includes('__APP_SEDIT__'));
        assert.ok(names.includes('__FILE__'));
        assert.ok(!names.includes('__APP_LEDIT__'));
      } else { assert.deepStrictEqual(names, []); }
    }
  });
  test('warns about reserved definitions without creating a jump target', () => {
    const { analysis, at } = fixture('#define __LINE__ 77\n#undef __DATE__\nint x = __LINE__;');
    assert.strictEqual(analysis.diagnostics.filter(d => d.severity === 'warning').length, 2);
    assert.deepStrictEqual(getDefinitions(at('__LINE__')), []);
    assert.ok(getHover(at('__LINE__'))?.plainText.includes('3'));
  });
  test('expands body locations and multiline argument locations independently', () => {
    const text = '#define INNER(x) x + __LINE__\n#define OUTER(x) INNER(x)\nint x = OUTER(\n __LINE__\n);';
    const { at } = fixture(text);
    const hover = getHover(at('OUTER('));
    assert.ok(hover?.plainText.includes('4 + 3'), hover?.plainText);
  });
  test('uses the source location of a nested invocation written in an argument', () => {
    const text = '#define INNER() __LINE__\n#define OUTER(x) x\nint x = OUTER(\n INNER()\n);';
    const { at } = fixture(text);
    assert.ok(getHover(at('OUTER('))?.plainText.includes('Expansion:\n4'));
  });
  test('does not substitute a system name inside a dollar identifier', () => {
    const text = '#define ID(x) x\nint $__LINE__ = 7;\nint x = ID($__LINE__);';
    const { at } = fixture(text);
    assert.ok(getHover(at('ID('))?.plainText.includes('Expansion:\n$__LINE__'));
  });
  test('keeps original argument boundaries when nested expansion produces commas', () => {
    const text = '#define PAIR() 1, 2\n#define ID(x) (x)\nint x = ID(PAIR());';
    const { at } = fixture(text);
    assert.ok(getHover(at('ID('))?.plainText.includes('Expansion:\n(1, 2)'));
  });
  test('annotates runtime macro expansion and preserves quoted names', () => {
    const text = '#define DATE(x) x + __DATE__ + "__LINE__"\nstring x = DATE(__TIME__);';
    const { at } = fixture(text);
    const hover = getHover(at('DATE('));
    assert.ok(/runtime/i.test(hover?.plainText ?? ''), hover?.plainText);
    assert.ok(hover?.plainText.includes('"__LINE__"'), hover?.plainText);
  });
  test('does not report uncertain declarations as definite duplicate or unresolved symbols', () => {
    const text = '#if __TIME__\nint optional;\nint shared;\n#else\nint shared;\n#endif\nvoid f(){ optional = shared; missing = 1; }';
    const { analysis } = fixture(text);
    assert.ok(!analysis.diagnostics.some(d => /optional|shared/.test(d.message)), JSON.stringify(analysis.diagnostics));
    assert.ok(analysis.diagnostics.some(d => d.message.includes('missing')));
  });
  test('retains parameter uncertainty and warns on undef with a trailing comment', () => {
    const { analysis } = fixture('#if __TIME__\nvoid run(int arg){ arg; }\n#endif\n#undef __TIME__ // runtime\n');
    assert.ok(!analysis.diagnostics.some(d => d.message.includes("identifier 'arg'")), JSON.stringify(analysis.diagnostics));
    assert.ok(analysis.diagnostics.some(d => d.severity === 'warning' && d.message.includes('__TIME__')));
  });
  test('does not let an uncertain local declaration hide an out-of-scope error', () => {
    const { analysis } = fixture('#if __TIME__\nvoid run(int arg){ arg; }\n#endif\nvoid other(){ arg = 1; }');
    const errors = analysis.diagnostics.filter(d => d.message.includes("identifier 'arg'"));
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].range.start.line, 3);
  });
});
