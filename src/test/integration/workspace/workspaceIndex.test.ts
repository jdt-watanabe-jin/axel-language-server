import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('WorkspaceIndex', () => {
  test('makes declarations from forced include directories visible to lookup', () => {
    const tempDir = createTempDir();
    const forcedDir = path.join(tempDir, 'forced');
    fs.mkdirSync(forcedDir);
    fs.writeFileSync(path.join(forcedDir, 'system.h'), 'class SystemClass {};');

    const index = createWorkspaceIndex({ forcedIncludeRoots: [forcedDir] });

    index.indexForcedIncludes();

    assert.deepStrictEqual(
      index.findDeclarations('SystemClass').map((declaration) => declaration.name),
      ['SystemClass']
    );
  });

  test('replaces declarations when an opened document version changes', () => {
    const index = createWorkspaceIndex();
    const uri = 'file:///main.axl';

    index.indexOpenDocument({ uri, version: 1, text: 'int oldName;' });
    index.indexOpenDocument({ uri, version: 2, text: 'int newName;' });

    assert.deepStrictEqual(index.findDeclarations('oldName'), []);
    assert.deepStrictEqual(
      index.findDeclarations('newName').map((declaration) => declaration.name),
      ['newName']
    );
  });

  test('foreground analysis does not synchronously index included disk documents', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'large.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'int includedValue;');
    const index = createWorkspaceIndex();

    const analysis = index.analyzeForegroundDocument({
      uri: mainUri,
      version: 1,
      text: '#include "large.h"\nint mainValue;'
    });

    assert.deepStrictEqual(
      analysis.declarations.map((declaration) => declaration.name),
      ['mainValue']
    );
    assert.deepStrictEqual(index.findDeclarations('includedValue'), []);
  });

  test('diagnostic analysis avoids synchronously indexing pending include documents', async () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class IncludedType {};');
    const index = createWorkspaceIndex();

    const analysis = index.analyzeDiagnosticDocument({
      uri: mainUri,
      version: 1,
      text: '#include "types.h"\nIncludedType value;'
    });

    assert.deepStrictEqual(analysis.declarations.map((declaration) => declaration.name), ['value']);
    assert.deepStrictEqual(index.findDeclarations('IncludedType'), []);

    await index.waitForBackgroundIndexing();

    assert.deepStrictEqual(
      index.findDeclarations('IncludedType').map((declaration) => declaration.name),
      ['IncludedType']
    );
  });

  test('full analysis adds workspace diagnostics after foreground analysis cached the same version', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const uri = pathToFileURL(mainPath).toString();
    const index = createWorkspaceIndex();
    const input = {
      uri,
      version: 1,
      text: '#include "missing.h"\nint value;'
    };

    const foreground = index.analyzeForegroundDocument(input);
    const full = index.analyzeDocument(input);

    assert.deepStrictEqual(foreground.diagnostics, []);
    assert.deepStrictEqual(full.diagnostics.map((diagnostic) => diagnostic.message), [
      "Include file not found: 'missing.h'."
    ]);
  });

  test('foreground analysis emits timing logs when logger is provided', () => {
    const entries: string[] = [];
    const index = createWorkspaceIndex({
      logger: {
        info: (message) => entries.push(message),
        error: () => undefined
      }
    });

    index.analyzeForegroundDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'int value;'
    });

    assert.ok(entries.some((entry) => (
      entry.includes('operation=workspace.foreground')
      && entry.includes('uri=file:///main.axl')
      && /durationMs=\d+/.test(entry)
    )));
  });

  test('foreground analysis indexes included disk documents in the background', async () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'int backgroundValue;');
    const index = createWorkspaceIndex();

    index.analyzeForegroundDocument({
      uri: mainUri,
      version: 1,
      text: '#include "types.h"\nint mainValue;'
    });
    await index.waitForBackgroundIndexing();

    assert.deepStrictEqual(
      index.findDeclarations('backgroundValue').map((declaration) => declaration.name),
      ['backgroundValue']
    );
  });

  test('terminates include cycles while indexing reachable disk documents', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    fs.writeFileSync(mainPath, '#include "types.h"\nint mainValue;');
    fs.writeFileSync(headerPath, '#include "main.axl"\nint headerValue;');

    const index = createWorkspaceIndex();

    index.indexDiskDocument(mainPath);

    assert.deepStrictEqual(
      index.findDeclarations('headerValue').map((declaration) => declaration.uri),
      [pathToFileURL(headerPath).toString()]
    );
  });

  test('finds declarations visible through resolved include edges only', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const includedPath = path.join(tempDir, 'included.h');
    const unrelatedPath = path.join(tempDir, 'unrelated.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(includedPath, 'class SharedName {};');

    const index = createWorkspaceIndex();
    index.indexOpenDocument({
      uri: pathToFileURL(unrelatedPath).toString(),
      version: 1,
      text: 'struct SharedName {};'
    });
    index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "included.h"\nSharedName value;'
    });

    assert.deepStrictEqual(
      index.findVisibleDeclarations(mainUri, 'SharedName').map((declaration) => declaration.detail),
      ['class']
    );
  });

  test('finds function-like macro definitions through includes', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, '#define WRAP(T) T value;\n');

    const index = createWorkspaceIndex();
    index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "macros.h"\nclass Box { WRAP(int) };'
    });

    assert.deepStrictEqual(
      index.findVisibleMacroDefinitions(mainUri, 'WRAP').map((macro) => ({
        name: macro.name,
        parameters: macro.parameters,
        replacementText: macro.replacementText
      })),
      [{
        name: 'WRAP',
        parameters: [{ label: 'T' }],
        replacementText: 'T value;'
      }]
    );
  });

  test('suppresses class body syntax errors for macros from included files', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const macroPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(macroPath, [
      '#define DEFINE_MAP_BASE(T) T value;',
      '#define DEFINE_MAP(T) DEFINE_MAP_BASE(T) T *Find(string key) { return NULL; }'
    ].join('\n'));

    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({
      uri: mainUri,
      version: 1,
      text: '#include "macros.h"\nclass C { DEFINE_MAP(int) };'
    });

    assert.deepStrictEqual(analysis.diagnostics, []);
  });

  test('keeps syntax errors for macro invocations before their include', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const macroPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(macroPath, '#define FIELD(T) T value;');

    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({
      uri: mainUri,
      version: 1,
      text: [
        'class C { FIELD(int) };',
        '#include "macros.h"'
      ].join('\n')
    });

    assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => diagnostic.message), [
      'Syntax error.'
    ]);
  });

  test('uses an included macro that supersedes an earlier local definition', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const macroPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(macroPath, '#define DECLARE_MEMBER(T) T includedValue;');

    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({
      uri: mainUri,
      version: 1,
      text: [
        '#define DECLARE_MEMBER(T) T',
        '#include "macros.h"',
        'class Container { DECLARE_MEMBER(int) };'
      ].join('\n')
    });

    assert.deepStrictEqual(analysis.diagnostics, []);
  });

  test('reports included macro arity after it supersedes an earlier local definition', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const macroPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(macroPath, '#define M(A, B) A value; B otherValue;');

    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({
      uri: mainUri,
      version: 1,
      text: [
        '#define M(A) A value;',
        '#include "macros.h"',
        'class Container { M(int) };'
      ].join('\n')
    });

    assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => diagnostic.message), [
      "Macro 'M' expects 2 argument but got 1."
    ]);
  });

  test('uses a local macro that supersedes an earlier included definition', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const macroPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(macroPath, '#define DECLARE_MEMBER(T) T');

    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({
      uri: mainUri,
      version: 1,
      text: [
        '#include "macros.h"',
        '#define DECLARE_MEMBER(T) T localValue;',
        'class Container { DECLARE_MEMBER(int) };'
      ].join('\n')
    });

    assert.deepStrictEqual(analysis.diagnostics, []);
  });

  test('keeps syntax errors before later local definitions and includes', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const macroPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(macroPath, '#define DECLARE_MEMBER(T) T includedValue;');

    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({
      uri: mainUri,
      version: 1,
      text: [
        'class Container { DECLARE_MEMBER(int) };',
        '#define DECLARE_MEMBER(T) T localValue;',
        '#include "macros.h"'
      ].join('\n')
    });

    assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => diagnostic.message), [
      'Syntax error.'
    ]);
  });

  test('handles AXEL string map member macros without syntax diagnostics', () => {
    const tempDir = createTempDir();
    const generatedDir = path.join(tempDir, '_generated');
    fs.mkdirSync(generatedDir);
    const mainPath = path.join(generatedDir, '_common.h');
    const basePath = path.join(tempDir, '_asxccbase.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(basePath, [
      '#define define_stringMAP_oneBase(p_class) \\',
      '  stringMAP mMapL; \\',
      'public: \\',
      '  int Add(string key, p_class value) { return 1; } \\',
      '  int Remove(string key) { return mMapL.Remove(key); }',
      '#define define_stringMAP_one(p_class) \\',
      '  define_stringMAP_oneBase(p_class) \\',
      '  p_class *Find(string key) { return NULL; }'
    ].join('\n'));

    const index = createWorkspaceIndex();
    const analysis = index.analyzeDocument({
      uri: mainUri,
      version: 1,
      text: [
        '#include "_asxccbase.h"',
        'class cstringmap_int { define_stringMAP_one(int) };',
        'class cstringmap_double { define_stringMAP_one(double) };',
        'class cstringmap_string { define_stringMAP_one(string) };'
      ].join('\n')
    });

    assert.deepStrictEqual(
      analysis.diagnostics.map((diagnostic) => diagnostic.message),
      []
    );
  });

  test('selects the latest visible macro definition by name', () => {
    const index = createWorkspaceIndex();
    const uri = 'file:///main.axl';
    index.indexOpenDocument({
      uri,
      version: 1,
      text: [
        '#define REPLACE(a) a',
        '#define REPLACE(a, b) a + b',
        'void main() {}'
      ].join('\n')
    });

    assert.strictEqual(index.findBestVisibleMacroDefinition(uri, 'REPLACE')?.replacementText, 'a + b');
  });

  test('finds declarations from includes resolved by forced include files', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const dependencyPath = path.join(tempDir, 'dependency.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, '#include "dependency.h"');
    fs.writeFileSync(dependencyPath, 'class ForcedDependency {};');

    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    index.indexOpenDocument({ uri: mainUri, version: 1, text: 'ForcedDependency value;' });

    assert.deepStrictEqual(
      index.findVisibleDeclarations(mainUri, 'ForcedDependency').map((declaration) => declaration.detail),
      ['class']
    );
  });

  test('uses forced include macros when collecting inactive ranges', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, '#define ENABLE_FEATURE 1');
    const lines = [
      '#ifdef ENABLE_FEATURE',
      'int activeValue;',
      '#else',
      'int inactiveValue;',
      '#endif'
    ];

    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text: lines.join('\n') });

    assert.deepStrictEqual(analysis.inactiveRanges, [
      { start: { line: 3, character: 0 }, end: { line: 3, character: 18 } }
    ]);
  });

  test('uses configured default defines when collecting inactive ranges', () => {
    const index = createWorkspaceIndex({ defines: ['NDEBUG', 'MY_CUSTOM_MACRO=1'] });
    const lines = [
      '#ifdef NDEBUG',
      'int releaseValue;',
      '#else',
      'int debugValue;',
      '#endif',
      '#if MY_CUSTOM_MACRO',
      'int customValue;',
      '#else',
      'int fallbackValue;',
      '#endif'
    ];

    const analysis = index.indexOpenDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: lines.join('\n')
    });

    assert.deepStrictEqual(analysis.inactiveRanges, [
      { start: { line: 3, character: 0 }, end: { line: 3, character: 15 } },
      { start: { line: 8, character: 0 }, end: { line: 8, character: 18 } }
    ]);
  });

  test('reanalyzes cached documents after configured default defines change', () => {
    const index = createWorkspaceIndex();
    const input = {
      uri: 'file:///main.axl',
      version: 1,
      text: [
        '#if SEMVER_TEST',
        'int activeWhenConfigured;',
        '#else',
        'int inactiveWhenConfigured;',
        '#endif'
      ].join('\n')
    };

    const before = index.indexOpenDocument(input);
    index.configure({ defines: ['SEMVER_TEST'] });
    const after = index.indexOpenDocument(input);

    assert.deepStrictEqual(before.inactiveRanges, [
      { start: { line: 1, character: 0 }, end: { line: 1, character: 25 } }
    ]);
    assert.deepStrictEqual(after.inactiveRanges, [
      { start: { line: 3, character: 0 }, end: { line: 3, character: 27 } }
    ]);
  });

  test('keeps declarations visible from guarded forced include files', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, [
      '#ifndef FORCED_H',
      '#define FORCED_H',
      '#define FORCED_VERSION 1',
      'class ForcedClass {};',
      '#endif'
    ].join('\n'));

    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: [
        '#if FORCED_VERSION',
        'ForcedClass value;',
        '#endif'
      ].join('\n')
    });

    assert.deepStrictEqual(analysis.inactiveRanges, []);
    assert.deepStrictEqual(
      index.findVisibleDeclarations(mainUri, 'ForcedClass').map((declaration) => declaration.detail),
      ['class']
    );
  });

  test('returns duplicate declarations from multiple forced includes deterministically', () => {
    const tempDir = createTempDir();
    const forcedDir = path.join(tempDir, 'forced');
    const mainPath = path.join(tempDir, 'main.axl');
    fs.mkdirSync(forcedDir);
    const firstPath = path.join(forcedDir, 'a.h');
    const secondPath = path.join(forcedDir, 'b.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(firstPath, 'class ForcedShared {};');
    fs.writeFileSync(secondPath, 'struct ForcedShared {};');

    const index = createWorkspaceIndex({ forcedIncludeRoots: [forcedDir] });
    index.indexOpenDocument({ uri: mainUri, version: 1, text: 'ForcedShared value;' });

    assert.deepStrictEqual(
      index.findVisibleDeclarations(mainUri, 'ForcedShared').map((declaration) => ({
        uri: declaration.uri,
        detail: declaration.detail
      })),
      [
        { uri: pathToFileURL(firstPath).toString(), detail: 'class' },
        { uri: pathToFileURL(secondPath).toString(), detail: 'struct' }
      ]
    );
  });

  test('caches forced include file discovery until configuration changes', () => {
    const tempDir = createTempDir();
    const forcedDir = path.join(tempDir, 'forced');
    const mainPath = path.join(tempDir, 'main.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.mkdirSync(forcedDir);
    fs.writeFileSync(path.join(forcedDir, 'a.h'), 'class FirstForced {};');

    const index = createWorkspaceIndex({ forcedIncludeRoots: [forcedDir] });
    index.indexOpenDocument({ uri: mainUri, version: 1, text: 'FirstForced first;' });
    fs.writeFileSync(path.join(forcedDir, 'b.h'), 'class SecondForced {};');

    assert.deepStrictEqual(index.findVisibleDeclarations(mainUri, 'SecondForced'), []);

    index.configure({ forcedIncludeRoots: [forcedDir] });

    assert.deepStrictEqual(
      index.findVisibleDeclarations(mainUri, 'SecondForced').map((declaration) => declaration.name),
      ['SecondForced']
    );
  });

  test('invalidates dependent documents when an included file changes', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    fs.writeFileSync(mainPath, '#include "types.h"\nint mainValue;');
    fs.writeFileSync(headerPath, 'int headerValue;');
    const index = createWorkspaceIndex();

    index.indexDiskDocument(mainPath);
    index.invalidateFile(headerPath);

    assert.deepStrictEqual(index.findDeclarations('mainValue'), []);
    assert.deepStrictEqual(index.findDeclarations('headerValue'), []);
  });
});

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
