import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { WorkspaceIndex } from '../analyzer/workspaceIndex';

suite('WorkspaceIndex', () => {
  test('makes declarations from forced include directories visible to lookup', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const forcedDir = path.join(tempDir, 'forced');
    fs.mkdirSync(forcedDir);
    fs.writeFileSync(path.join(forcedDir, 'system.h'), 'class SystemClass {};');

    const index = new WorkspaceIndex({ forcedIncludeRoots: [forcedDir] });

    index.indexForcedIncludes();

    assert.deepStrictEqual(
      index.findDeclarations('SystemClass').map((declaration) => declaration.name),
      ['SystemClass']
    );
  });

  test('replaces declarations when an opened document version changes', () => {
    const index = new WorkspaceIndex();
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'large.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'int includedValue;');
    const index = new WorkspaceIndex();

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

  test('full analysis adds workspace diagnostics after foreground analysis cached the same version', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const uri = pathToFileURL(mainPath).toString();
    const index = new WorkspaceIndex();
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
    const index = new WorkspaceIndex({
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'int backgroundValue;');
    const index = new WorkspaceIndex();

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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    fs.writeFileSync(mainPath, '#include "types.h"\nint mainValue;');
    fs.writeFileSync(headerPath, '#include "main.axl"\nint headerValue;');

    const index = new WorkspaceIndex();

    index.indexDiskDocument(mainPath);

    assert.deepStrictEqual(
      index.findDeclarations('headerValue').map((declaration) => declaration.uri),
      [pathToFileURL(headerPath).toString()]
    );
  });

  test('finds declarations visible through resolved include edges only', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const includedPath = path.join(tempDir, 'included.h');
    const unrelatedPath = path.join(tempDir, 'unrelated.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(includedPath, 'class SharedName {};');

    const index = new WorkspaceIndex();
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

  test('finds declarations from includes resolved by forced include files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const dependencyPath = path.join(tempDir, 'dependency.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, '#include "dependency.h"');
    fs.writeFileSync(dependencyPath, 'class ForcedDependency {};');

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    index.indexOpenDocument({ uri: mainUri, version: 1, text: 'ForcedDependency value;' });

    assert.deepStrictEqual(
      index.findVisibleDeclarations(mainUri, 'ForcedDependency').map((declaration) => declaration.detail),
      ['class']
    );
  });

  test('uses forced include macros when collecting inactive ranges', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
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

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text: lines.join('\n') });

    assert.deepStrictEqual(analysis.inactiveRanges, [
      { start: { line: 3, character: 0 }, end: { line: 3, character: 18 } }
    ]);
  });

  test('uses configured default defines when collecting inactive ranges', () => {
    const index = new WorkspaceIndex({ defines: ['NDEBUG', 'MY_CUSTOM_MACRO=1'] });
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
    const index = new WorkspaceIndex();
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
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

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const forcedDir = path.join(tempDir, 'forced');
    const mainPath = path.join(tempDir, 'main.axl');
    fs.mkdirSync(forcedDir);
    const firstPath = path.join(forcedDir, 'a.h');
    const secondPath = path.join(forcedDir, 'b.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(firstPath, 'class ForcedShared {};');
    fs.writeFileSync(secondPath, 'struct ForcedShared {};');

    const index = new WorkspaceIndex({ forcedIncludeRoots: [forcedDir] });
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const forcedDir = path.join(tempDir, 'forced');
    const mainPath = path.join(tempDir, 'main.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.mkdirSync(forcedDir);
    fs.writeFileSync(path.join(forcedDir, 'a.h'), 'class FirstForced {};');

    const index = new WorkspaceIndex({ forcedIncludeRoots: [forcedDir] });
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    fs.writeFileSync(mainPath, '#include "types.h"\nint mainValue;');
    fs.writeFileSync(headerPath, 'int headerValue;');
    const index = new WorkspaceIndex();

    index.indexDiskDocument(mainPath);
    index.invalidateFile(headerPath);

    assert.deepStrictEqual(index.findDeclarations('mainValue'), []);
    assert.deepStrictEqual(index.findDeclarations('headerValue'), []);
  });
});
