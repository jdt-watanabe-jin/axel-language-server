import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver/node';
import { ProjectScope } from '../../../analyzer/projectScope';
import { TypeHierarchyIndex } from '../../../analyzer/typeHierarchy/index';
import { getDeclarations } from '../../../analyzer/navigationTargets';
import { getDefinitions, getReferences } from '../../../analyzer/navigation';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { useWorkspaceFixtures } from '../../support/workspace';
import { positionFromOffset } from '../../support/source';

suite('Navigation semantics migrated from stdio', () => {
  const hierarchies = new Set<TypeHierarchyIndex>();
  teardown(async () => { await Promise.all([...hierarchies].map(index => index.dispose())); hierarchies.clear(); });
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
  function fixture(text: string, files: Record<string, string> = {}, name = 'main.axl') {
    const root = createTempDir();
    const uri = (file: string) => pathToFileURL(path.join(root, file)).toString();
    for (const [file, contents] of Object.entries(files)) { fs.writeFileSync(path.join(root, file), contents); }
    const opened = [{ uri: uri(name), version: 1, text }];
    const scope = new ProjectScope(); scope.setRoots([uri('')]); scope.setOpenUris([uri(name)]);
    const hierarchy = new TypeHierarchyIndex(scope, () => opened, message => assert.fail(message));
    hierarchy.resume(); hierarchies.add(hierarchy);
    return { uri, hierarchy, navigate: (kind: 'declaration' | 'implementation', word: string, last = false) =>
      hierarchy.navigate(kind, uri(name), positionFromOffset(text, last ? text.lastIndexOf(word) : text.indexOf(word)), CancellationToken.None) };
  }
  test('does not merge method implementations from incompatible macro contexts', async () => {
    const f = fixture('#define ARG int\n#include "base.h"\nvoid main() { Base value; value.run; }', {
      'base.h': 'class Base { public: virtual void run(ARG value); };',
      'child.axl': '#define ARG double\n#include "base.h"\nclass Child : Base { public: void run(double value) {} };'
    });
    assert.strictEqual((await f.navigate('declaration', 'run')).length, 1);
    assert.deepStrictEqual(await f.navigate('implementation', 'run'), []);
  });
  test('finds overrides through a global typedef receiver', async () => {
    const text = 'class R1Base { public: virtual void run(int value); };\ntypedef R1Base R1Alias;\nR1Alias object;\nint choose(int value);\nint choose(int value) { return value; }\nvoid main() { choose(1); object.run(1); }';
    const f = fixture(text, { 'main.axl': text, 'child.axl': '#include "main.axl"\nclass R1Child : R1Base { public: void run(int value) {} };' });
    assert.strictEqual((await f.navigate('implementation', 'run', true)).length, 1);
  });
  test('matches value parameter qualifiers using AXEL signature semantics', async () => {
    const f = fixture('int foo(int value);\nint foo(const int value) { return value; }');
    assert.strictEqual((await f.navigate('declaration', 'foo', true))[0]?.range.start.line, 0);
  });
  test('type implementations exclude inherited and explicit pure virtual classes', async () => {
    const f = fixture('class Base { public: virtual void run() = 0; };\nclass Abstract : Base {};\nclass Concrete : Abstract { public: void run() {} };\nclass AgainAbstract : Concrete { public: virtual void run() = 0; };\nclass StillConcrete : Concrete {};');
    assert.deepStrictEqual((await f.navigate('implementation', 'Base')).map(item => item.range.start.line), [2, 4]);
  });
  test('keeps method definition identity when a separate prototype exists', () => {
    const text = 'class C { public: void run(int value); };\nvoid C::run(int value) {}\nvoid main() { C c; c.run(1); }';
    const index = createWorkspaceIndex();
    const uri = pathToFileURL(path.join(createTempDir(), 'main.axl')).toString();
    const analysis = index.indexOpenDocument({ uri, version: 1, text });
    const input = { analysis, workspaceIndex: index, position: positionFromOffset(text, text.lastIndexOf('run')) };
    const definitions = getDefinitions(input);
    assert.strictEqual(definitions.length, 1); assert.strictEqual(definitions[0].range.start.line, 1);
    const declarations = getDeclarations(input);
    assert.strictEqual(declarations.length, 1); assert.strictEqual(declarations[0].range.start.line, 0);
    assert.ok(getReferences({ ...input, includeDeclaration: false }).some(item => item.range.start.line === 2));
  });
  test('keeps distinct same-named bases in separate document contexts', async () => {
    const text = 'class Base { int x; };';
    const f = fixture(text, { 'one.h': text, 'two.h': text, 'child.axl': '#include "two.h"\nclass Child : Base { int z; };' }, 'one.h');
    const base = (await f.hierarchy.prepare(f.uri('one.h'), { line: 0, character: 6 }, CancellationToken.None))![0];
    assert.strictEqual(base.name, 'Base');
    assert.deepStrictEqual(await f.hierarchy.subtypes(base.data, CancellationToken.None), []);
  });
  test('returns nested original-source selections for strings, comments and expressions in input order', () => {
    const text = 'void main() { string s = "hello"; /* comment */ int n = (1 + 2); }';
    const positions = ['hello', 'comment', '1 +'].map(word => positionFromOffset(text, text.indexOf(word)));
    const result = runAnalysisSteps(new DocumentAnalyzer().getSelectionRangesSteps({ uri: 'file:///selection.axl', version: 1, text }, positions));
    assert.strictEqual(result.length, positions.length);
    for (let i = 0; i < result.length; i++) {
      let current = result[i];
      assert.ok(current.range.start.character <= positions[i].character && current.range.end.character >= positions[i].character);
      while (current.parent) {
        assert.ok(current.parent.range.start.character <= current.range.start.character);
        assert.ok(current.parent.range.end.character >= current.range.end.character);
        assert.notDeepStrictEqual(current.range, current.parent.range);
        current = current.parent;
      }
    }
  });
});
