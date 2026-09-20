import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';
import { getHover } from '../../../analyzer/hover';
import { getDefinitions, getReferences } from '../../../analyzer/navigation';
import { getCompletions } from '../../../analyzer/completion';
import { getSignatureHelp } from '../../../analyzer/signatureHelp';

suite('Login scope', () => {
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
  test('updates startup declarations when a higher-priority include is created', () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'bin')); fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'bin/_login.axl'), '#include "api.h"\n');
    fs.writeFileSync(path.join(root, 'lib/api.h'), 'int previous;\n');
    const index = createWorkspaceIndex({ sxmHome: root, includeRoots: [path.join(root, 'lib')] });
    const uri = pathToFileURL(path.join(root, 'main.axl')).toString();
    index.indexOpenDocument({ uri, version: 1, text: 'void main() {}\n' });
    assert.strictEqual(index.findVisibleDeclarations(uri, 'previous').length, 1);
    const header = path.join(root, 'bin/api.h'); fs.writeFileSync(header, 'int current;\n');
    index.invalidatePaths([pathToFileURL(header).toString()]);
    assert.strictEqual(index.findVisibleDeclarations(uri, 'current').length, 1);
    assert.strictEqual(index.findVisibleDeclarations(uri, 'previous').length, 0);
  });
  test('reuses completed forced-header analysis in the isolated startup index', () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'bin'));
    const forced = path.join(root, 'forced.h');
    fs.writeFileSync(forced, '#define TYPE int\nclass Forced { int field; };');
    fs.writeFileSync(path.join(root, 'bin/_login.axl'), '#define TYPE string\nForced shared;');
    let parses = 0;
    const index = createWorkspaceIndex({ sxmHome: root, forcedIncludeFiles: [forced], logger: {
      info(message) { if (message.includes('operation=document.analyze') && message.includes('/forced.h ')) { parses++; } },
      error(message) { assert.fail(message); }
    } });
    const uri = pathToFileURL(path.join(root, 'main.axl')).toString();
    const result = index.indexOpenDocument({ uri, version: 1, text: 'void main(){ shared.field = 1; TYPE local = 1; }' });
    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(index.findVisibleMacroDefinitions(uri, 'TYPE').at(-1)?.replacementText, 'int');
    assert.ok(parses <= 2, `Forced header was analyzed ${parses} times instead of once per phase`);
  });
  test('preserves undef before a nested startup include', () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin/_login.axl'), '#define VALUE 1\n#undef VALUE\n#include "state.h"');
    fs.writeFileSync(path.join(root, 'bin/state.h'), '#ifdef VALUE\nint wrong;\n#else\nint correct;\n#endif');
    const index = createWorkspaceIndex({ sxmHome: root });
    const uri = pathToFileURL(path.join(root, 'main.axl')).toString();
    index.indexOpenDocument({ uri, version: 1, text: 'void main(){ correct = 1; }' });
    assert.strictEqual(index.findVisibleDeclarations(uri, 'correct').length, 1);
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'wrong'), []);
  });
  function fixture(tool = 'axel') {
    const root = createTempDir();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(bin, '_asca'));
    fs.mkdirSync(path.join(bin, '_spicechart'));
    fs.writeFileSync(path.join(bin, '_login.axl'), '#include "shared.h"\nint sharedCount;\nint loginAdd(int x) { return x+1; }\nvoid main() { int privateCount; }');
    fs.writeFileSync(path.join(bin, 'shared.h'), '#include "nested.h"\nclass LoginState { public: int value; int get(int x) { return x; } };\nLoginState state;\n#define LOGIN_ONLY 1');
    fs.writeFileSync(path.join(bin, 'nested.h'), 'int transitiveValue;');
    fs.writeFileSync(path.join(bin, '_asca/_login.axl'), 'int ascaOnly; void main() {}');
    fs.writeFileSync(path.join(bin, '_spicechart/_login.axl'), 'int chartOnly; void main() {}');
    const index = createWorkspaceIndex();
    index.configure({ sxmHome: root, tool });
    const uri = pathToFileURL(path.join(root, 'consumer.axl')).toString();
    const input = { uri, version: 1, text: 'void main() { sharedCount; state.value; }' };
    index.indexOpenDocument(input);
    return { root, bin, index, uri, input };
  }
  test('exports globals and included classes and functions, excluding startup main and locals', () => {
    const { index, uri } = fixture();
    for (const name of ['sharedCount', 'transitiveValue', 'LoginState', 'state', 'loginAdd']) {
      assert.strictEqual(index.findVisibleDeclarations(uri, name).length, 1, name);
    }
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'privateCount'), []);
    assert.ok(!index.findVisibleDeclarations(uri, 'main').some(d => d.uri.endsWith('/_login.axl')));
    assert.deepStrictEqual(index.findVisibleMacroDefinitions(uri, 'LOGIN_ONLY'), []);
    assert.ok(!index.getAnalyzedDocument(uri)!.symbols.some(s => s.name === 'LoginState'));
  });
  test('selects exactly the configured tool and removes declarations when home is cleared', () => {
    for (const [tool, expected] of [['axel', 'sharedCount'], ['ismo', 'sharedCount'], ['asca', 'ascaOnly'], ['spicechart', 'chartOnly']]) {
      const { index, uri, input } = fixture(tool);
      assert.strictEqual(index.findVisibleDeclarations(uri, expected).length, 1, tool);
      if (tool === 'asca' || tool === 'spicechart') { assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'sharedCount'), []); }
      index.configure({ sxmHome: '' });
      index.indexOpenDocument(input);
      assert.deepStrictEqual(index.findVisibleDeclarations(uri, expected), []);
    }
  });
  test('uses shared types for member checks and function arguments', () => {
    const { index, uri } = fixture();
    const analysis = index.indexOpenDocument({ uri, version: 2, text: 'void main() { int n=state; loginAdd(); }' });
    assert.ok(analysis.diagnostics.some(d => d.code === 'axel.type.initialization'), JSON.stringify(analysis.diagnostics));
  });
  test('provides navigation, documentation, signatures and cached semantic lookup', () => {
    const { index, uri, bin } = fixture();
    fs.writeFileSync(path.join(bin, '_login.axl'), '/** @brief Shared counter. */\nint counter;\n/** @brief Add one. */\nint loginAdd(int x) { return x+1; }\nvoid main() { counter=1; }');
    index.invalidateFile(path.join(bin, '_login.axl'));
    const text = 'void main() { counter; loginAdd(1); }';
    const analysis = index.indexOpenDocument({ uri, version: 2, text });
    const position = { line: 0, character: text.indexOf('counter') + 1 };
    const input = { analysis, text, position, workspaceIndex: index };
    assert.strictEqual(getDefinitions(input)[0]?.uri, pathToFileURL(path.join(bin, '_login.axl')).toString());
    assert.ok(getHover(input)?.markdown.includes('Shared counter.'));
    assert.ok(getCompletions(input).some(item => item.name === 'loginAdd'));
    assert.ok(getReferences({ ...input, includeDeclaration: false }).some(r => r.uri.endsWith('/_login.axl')));
    assert.ok(getSignatureHelp({ ...input, position: { line: 0, character: text.indexOf('(1') + 1 } }));
    assert.strictEqual(index.semanticTokenWorkspaceIndex(uri).findVisibleDeclarations?.(uri, 'counter').length, 1);
  });
  test('reloads unchanged consumers after edits, close, creation and deletion', () => {
    const { index, uri, bin, input } = fixture();
    const login = path.join(bin, '_login.axl');
    const loginUri = pathToFileURL(login).toString();
    index.indexOpenDocument({ uri: loginUri, version: 10, text: 'int unsaved; void main() {}' });
    index.indexOpenDocument(input);
    assert.strictEqual(index.findVisibleDeclarations(uri, 'unsaved').length, 1);
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'sharedCount'), []);
    index.deleteDocument(loginUri);
    index.indexOpenDocument(input);
    assert.strictEqual(index.findVisibleDeclarations(uri, 'sharedCount').length, 1);
    fs.writeFileSync(login, '#include "new.h"\nvoid main() {}');
    index.invalidateUri(loginUri);
    index.indexOpenDocument(input);
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'sharedCount'), []);
    const header = path.join(bin, 'new.h');
    fs.writeFileSync(header, 'int created;');
    index.invalidateFile(header);
    index.indexOpenDocument(input);
    assert.strictEqual(index.findVisibleDeclarations(uri, 'created').length, 1);
    fs.unlinkSync(header);
    index.invalidateFile(header);
    index.indexOpenDocument(input);
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'created'), []);
  });
  test('uses unsaved include content and isolates startup macro conditions', () => {
    const { index, uri, bin, input } = fixture();
    const header = path.join(bin, 'shared.h');
    const editorUri = pathToFileURL(header).toString().replace(/file:\/\/\/([A-Z]):/, (_match, drive: string) => `file:///${drive.toLowerCase()}%3A`);
    index.indexOpenDocument({ uri: editorUri, version: 4, text: 'int editedHeader;' });
    index.indexOpenDocument(input);
    assert.strictEqual(index.findVisibleDeclarations(uri, 'editedHeader').length, 1);
    index.deleteDocument(editorUri);
    fs.writeFileSync(path.join(bin, '_login.axl'), '#define STARTUP_FLAG 1\n#include "conditional.h"\nvoid main() {}');
    fs.writeFileSync(path.join(bin, 'conditional.h'), '#if STARTUP_FLAG\nint startupOnly;\n#else\nint ordinaryOnly;\n#endif');
    index.invalidateFile(path.join(bin, '_login.axl'));
    index.indexOpenDocument({ uri, version: 2, text: '#define STARTUP_FLAG 0\nvoid main() { startupOnly; }' });
    assert.strictEqual(index.findVisibleDeclarations(uri, 'startupOnly').length, 1);
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'ordinaryOnly'), []);
    assert.deepStrictEqual(index.findVisibleMacroDefinitions(uri, 'STARTUP_FLAG').map(m => m.replacementText), ['0']);
  });
  test('keeps private aliases useful inside exported types without publishing them', () => {
    const { index, uri, bin } = fixture();
    fs.writeFileSync(path.join(bin, '_login.axl'), 'class Hidden { public: int n; };\ntypedef Hidden Alias;\nAlias shared;\nvoid main() {}');
    index.invalidateFile(path.join(bin, '_login.axl'));
    const analysis = index.indexOpenDocument({ uri, version: 2, text: 'void main() { int n=shared; }' });
    assert.ok(analysis.diagnostics.some(d => d.code === 'axel.type.initialization'));
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'Alias'), []);
    const text = 'void main() { shared.n; }';
    const memberAnalysis = index.indexOpenDocument({ uri, version: 3, text });
    assert.ok(getHover({ analysis: memberAnalysis, workspaceIndex: index, position: { line: 0, character: text.indexOf('.n') + 1 } }));
  });
  test('prefers ordinary includes over startup declarations in both lookup and type checking', () => {
    const { index, uri, root } = fixture();
    fs.writeFileSync(path.join(root, 'ordinary.h'), 'int state;');
    const analysis = index.indexOpenDocument({ uri, version: 2, text: '#include "ordinary.h"\nvoid main() { int n=state; }' });
    assert.strictEqual(index.findVisibleDeclarations(uri, 'state')[0].uri, pathToFileURL(path.join(root, 'ordinary.h')).toString());
    assert.ok(!analysis.diagnostics.some(d => d.code === 'axel.type.initialization'), JSON.stringify(analysis.diagnostics));
  });
  test('does not export local include declarations or inactive declarations and handles cycles', () => {
    const { index, uri, bin } = fixture();
    fs.writeFileSync(path.join(bin, '_login.axl'), '#if 0\nint disabled;\n#endif\n#include "cycle.h"\nvoid main() {\n#include "local.h"\n}');
    fs.writeFileSync(path.join(bin, 'cycle.h'), '#include "_login.axl"\nint cyclic;');
    fs.writeFileSync(path.join(bin, 'local.h'), 'int inside;');
    index.invalidateFile(path.join(bin, '_login.axl'));
    index.indexOpenDocument({ uri, version: 2, text: 'void main() {}' });
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'inside'), []);
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'disabled'), []);
    assert.strictEqual(index.findVisibleDeclarations(uri, 'cyclic').length, 1);
  });
  test('does not merge startup members into a redeclared ordinary class', () => {
    const { index, uri } = fixture();
    const text = 'class LoginState { public: int own; };\nvoid main() { LoginState local; local.value; }';
    const analysis = index.indexOpenDocument({ uri, version: 2, text });
    assert.strictEqual(getHover({ analysis, workspaceIndex: index, position: { line: 1, character: text.split('\n')[1].indexOf('value') + 1 } }), null);
  });
  test('preserves uncertainty without declaring possible startup globals definitely missing', () => {
    const { index, uri, bin } = fixture();
    fs.writeFileSync(path.join(bin, '_login.axl'), '#if __TIME__\nint possible;\n#endif\nvoid main() {}');
    index.invalidateFile(path.join(bin, '_login.axl'));
    const analysis = index.indexOpenDocument({ uri, version: 2, text: 'void main() { possible; }' });
    assert.deepStrictEqual(index.findVisibleDeclarations(uri, 'possible'), []);
    assert.ok(!analysis.diagnostics.some(d => d.message.includes("identifier 'possible'")), JSON.stringify(analysis.diagnostics));
  });
  test('invalidates startup types when their forced-include dependencies change', () => {
    const { index, uri, bin, root } = fixture();
    const forced = path.join(root, 'forced.h');
    fs.writeFileSync(forced, 'typedef int Value;');
    fs.writeFileSync(path.join(bin, '_login.axl'), 'Value shared; void main() {}');
    index.configure({ sxmHome: root, forcedIncludeFiles: [forced] });
    const input = { uri, version: 2, text: 'void main() { int n=shared; }' };
    assert.ok(!index.indexOpenDocument(input).diagnostics.some(d => d.code === 'axel.type.initialization'));
    assert.strictEqual(index.findVisibleDeclarations(uri, 'shared')[0].typeName, 'int');
    fs.writeFileSync(forced, 'class Object {int n;}; typedef Object Value;');
    index.invalidateFile(forced);
    assert.ok(index.indexOpenDocument(input).diagnostics.some(d => d.code === 'axel.type.initialization'));
  });

  test('indexes shared forced headers a bounded number of times during startup', () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'bin'));
    const headers = path.join(root, 'headers');
    fs.mkdirSync(headers);
    fs.writeFileSync(path.join(root, 'bin/_login.axl'), 'int shared; void main() {}');
    fs.writeFileSync(path.join(headers, 'common.h'), '#define COMMON 1\nclass Common {};');
    for (let n = 0; n < 12; n++) {
      fs.writeFileSync(path.join(headers, `header${n}.h`), `#define HEADER_${n} 1\n#include "common.h"\nint forced${n};`);
    }
    let commonAnalyses = 0;
    const index = createWorkspaceIndex({ sxmHome: root, forcedIncludeRoots: [headers], logger: {
      info(message) { if (message.includes('operation=document.analyze') && message.includes('/common.h ')) { commonAnalyses++; } },
      error(message) { assert.fail(message); }
    } });
    index.getLoginDependencies();
    assert.ok(commonAnalyses <= 4, `shared forced header parsed ${commonAnalyses} times`);
    const previous = commonAnalyses;
    index.getLoginDependencies();
    assert.strictEqual(commonAnalyses, previous);
  });
});
