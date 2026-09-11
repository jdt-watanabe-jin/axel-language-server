import { normalizeTargetPlatform } from '../../../analyzer/targetPlatform';
import * as assert from 'assert';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import { getHover } from '../../../analyzer/hover';
import { getCompletions } from '../../../analyzer/completion';
import { getDefinitions } from '../../../analyzer/navigation';
import { prepareRename } from '../../../analyzer/rename';
import { positionFromOffset } from '../../support/source';

suite('target platform', () => {
  const uri = 'file:///platform/main.axl';
  const names = ['__OS_UNIX__', '__OS_WINDOWS__', '__OS_LINUX__', '__OS_SOLARIS__', '__OS_HPUX__', '__CPU_x86__', '__CPU_x86_64__', '__CPU_HPPA__', '__CPU_SPARC__', '__OS_32bit__', '__OS_64bit__'];
  const cases: [string, string[]][] = [
    ['windows-x86', ['__OS_WINDOWS__', '__CPU_x86__', '__OS_32bit__']],
    ['windows-x64', ['__OS_WINDOWS__', '__CPU_x86_64__', '__OS_64bit__']],
    ['linux-x86', ['__OS_UNIX__', '__OS_LINUX__', '__CPU_x86__', '__OS_32bit__']],
    ['linux-x64', ['__OS_UNIX__', '__OS_LINUX__', '__CPU_x86_64__', '__OS_64bit__']],
    ['solaris-x86', ['__OS_UNIX__', '__OS_SOLARIS__', '__CPU_x86__', '__OS_32bit__']],
    ['solaris-x64', ['__OS_UNIX__', '__OS_SOLARIS__', '__CPU_x86_64__', '__OS_64bit__']],
    ['solaris-sparc32', ['__OS_UNIX__', '__OS_SOLARIS__', '__CPU_SPARC__', '__OS_32bit__']],
    ['solaris-sparc64', ['__OS_UNIX__', '__OS_SOLARIS__', '__CPU_SPARC__', '__OS_64bit__']],
    ['hpux-hppa32', ['__OS_UNIX__', '__OS_HPUX__', '__CPU_HPPA__', '__OS_32bit__']],
    ['hpux-hppa64', ['__OS_UNIX__', '__OS_HPUX__', '__CPU_HPPA__', '__OS_64bit__']]
  ];
  const index = new WorkspaceIndex();
  for (const [targetPlatform, enabled] of cases) {
    test(`evaluates and exposes all macros for ${targetPlatform}`, () => {
      index.configure({ targetPlatform, tool: 'ismo', defines: names.map(name => `${name}=9`) });
      const text = names.map((name, i) => `#if defined(${name}) && ${name} == ${enabled.includes(name) ? 1 : 0}\nint ok${i};\n#else\nint wrong${i};\n#endif\nint value${i} = ${name};`).join('\n');
      const analysis = index.analyzeDocument({ uri, version: 1, text });
      assert.deepStrictEqual(analysis.diagnostics, []);
      assert.strictEqual(analysis.declarations.filter(d => d.name.startsWith('ok')).length, 11);
      assert.ok(!analysis.declarations.some(d => d.name.startsWith('wrong')));
      for (const name of targetPlatform === 'windows-x64' ? ['__OS_WINDOWS__', '__OS_UNIX__'] : []) {
        const context = { analysis, workspaceIndex: index, position: positionFromOffset(text, text.lastIndexOf(name)) };
        assert.ok(getHover(context)?.plainText.includes(`${name} (int)\n${enabled.includes(name) ? 1 : 0}`));
        assert.ok(getCompletions({ ...context, text }).some(item => item.name === name));
        assert.deepStrictEqual(getDefinitions(context), []);
        assert.strictEqual(prepareRename(context), null);
      }
    });
  }
  test('changes branches and expansion without editing the document', () => {
    const text = '#if __OS_WINDOWS__\nint win;\n#else\nint unix;\n#endif\n#define MODE() __OS_WINDOWS__ + __OS_64bit__\nint mode = MODE();';
    for (const [targetPlatform, declaration, expansion] of [['windows-x64', 'win', '1 + 1'], ['hpux-hppa32', 'unix', '0 + 0'], ['windows-x64', 'win', '1 + 1']]) {
      index.configure({ targetPlatform });
      const analysis = index.analyzeDocument({ uri, version: 1, text });
      assert.ok(analysis.declarations.some(d => d.name === declaration));
      assert.ok(!analysis.declarations.some(d => d.name === (declaration === 'win' ? 'unix' : 'win')));
      assert.ok(getHover({ analysis, workspaceIndex: index, position: positionFromOffset(text, text.lastIndexOf('MODE(')) })?.plainText.includes(`Expansion:\n${expansion}`));
    }
  });
  test('defaults omitted and invalid settings to windows-x64', () => {
    for (const value of [undefined, null, '', 'linux-arm64', 42, '__proto__']) {
      assert.strictEqual(normalizeTargetPlatform(value), 'windows-x64');
    }
    const index = new WorkspaceIndex();
    const text = '#if __OS_WINDOWS__ && __CPU_x86_64__ && __OS_64bit__\nint expected;\n#endif';
    const analysis = index.analyzeDocument({ uri, version: 1, text });
    assert.deepStrictEqual(analysis.diagnostics, []);
    assert.ok(analysis.declarations.some(d => d.name === 'expected'));
  });
  test('protects all platform macros from source mutations', () => {
    index.configure({ targetPlatform: 'linux-x64' });
    const text = names.map(name => `#define ${name} 9\n#undef ${name}`).join('\n') + '\n#if __OS_LINUX__ && !__OS_WINDOWS__\nint expected;\n#endif';
    const analysis = index.analyzeDocument({ uri, version: 1, text });
    assert.strictEqual(analysis.diagnostics.filter(d => d.severity === 'warning').length, 22);
    assert.ok(analysis.declarations.some(d => d.name === 'expected'));
  });
});