import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getHover } from '../../../analyzer/hover';
import { assertExternalHover } from '../../support/hoverAssertions';
import { recoveredStaticMemberFixture } from '../../support/recoveredStaticMember';
import { analyze, positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';
suite('getHover', () => {
  test('resolves a static qualified method from a malformed forced include class', () => {
    const fixture = recoveredStaticMemberFixture();

    const hover = getHover({
      analysis: fixture.analysis,
      position: { line: 0, character: 20 },
      workspaceIndex: fixture.workspaceIndex
    });

    assertExternalHover(hover, 'static int FILE::IsDirectory(string fname)',
      process.platform === 'win32' ? 'file:///file.h' : '/file.h');
  });

  test('hovers the first visible declaration from multiple includes', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const firstPath = path.join(tempDir, 'a.h');
    const secondPath = path.join(tempDir, 'b.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(firstPath, 'class SharedName {};');
    fs.writeFileSync(secondPath, 'struct SharedName {};');

    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "a.h"\n#include "b.h"\nSharedName value;'
    });

    const hover = getHover({
      analysis,
      position: { line: 2, character: 2 },
      workspaceIndex: index
    });

    assertExternalHover(hover, 'class SharedName', firstPath);
  });

  test('resolves inherited properties through a forced-include base class', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, [
      'class Base { int inheritedValue; };',
      'class Child : public Base {};'
    ].join('\n'));

    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const markedText = 'void main() { Child child; child.|inheritedValue; }';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const hover = getHover({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assertExternalHover(hover, 'int Base::inheritedValue', forcedPath);
  });

  test('returns a qualified hover for a method call resolved from an include', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'widget.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class Widget { int Now() {} };');

    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "widget.h"\nvoid main() { Widget widget; widget.Now(); }'
    });

    const hover = getHover({
      analysis,
      position: { line: 1, character: 37 },
      workspaceIndex: index
    });

    assertExternalHover(hover, 'int Widget::Now()', headerPath);
  });

  test('returns a qualified hover for a method prototype resolved from a forced include', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'class DATE { double LapTime(); };');

    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: 'void main() { DATE d_double; d_double.LapTime(); }'
    });

    const hover = getHover({
      analysis,
      position: { line: 0, character: 39 },
      workspaceIndex: index
    });

    assertExternalHover(hover, 'double DATE::LapTime()', forcedPath);
  });

  test('returns resolved include file hover at an include path', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class IncludedType {};');
    const index = createWorkspaceIndex();
    const markedText = '#include "|types.h"\nIncludedType value;';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const hover = getHover({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assert.deepStrictEqual(hover, {
      markdown: `\`\`\`text\ninclude: ${headerPath}\n\`\`\``,
      plainText: `include: ${headerPath}`
    });
    assert.strictEqual(getHover({
      analysis, position: positionFromOffset(text, markerOffset), workspaceIndex: index, locale: 'ja'
    })?.plainText, `インクルード: ${headerPath}`);
  });

  test('uses trailing comments as object-like macro documentation', () => {
    const analysis = analyze('#define Lctgen_DUMP_DEBUG 1 // debug log flag\nvoid main() { int value = Lctgen_DUMP_DEBUG; }');

    const hover = getHover({
      analysis,
      position: { line: 1, character: 26 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\n#define Lctgen_DUMP_DEBUG 1\n```\n\ndebug log flag',
      plainText: '#define Lctgen_DUMP_DEBUG 1\ndebug log flag'
    });
  });

  test('uses trailing comments as function-like macro documentation', () => {
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: '#define MAX(a, b) ((a) > (b) ? (a) : (b)) // pick larger\nvoid main() { int value = MAX(1, 2); }'
    });

    const hover = getHover({
      analysis,
      position: { line: 1, character: 26 },
      workspaceIndex: index
    });

    assert.deepStrictEqual(hover, {
      markdown: [
        '```axel',
        '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
        '```',
        '',
        'pick larger',
        '',
        'Expansion:',
        '',
        '```axel',
        '((1) > (2) ? (1) : (2))',
        '```'
      ].join('\n'),
      plainText: [
        '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
        'pick larger',
        'Expansion:',
        '((1) > (2) ? (1) : (2))'
      ].join('\n')
    });
  });

  test('shows expansion for function-like macro invocation hover', () => {
    const index = createWorkspaceIndex();
    const uri = 'file:///main.axl';
    const analysis = index.indexOpenDocument({
      uri,
      version: 1,
      text: [
        '#define FIELD(T) T value;',
        'class C { FIELD(int) };'
      ].join('\n')
    });

    const hover = getHover({
      analysis,
      position: { line: 1, character: 10 },
      workspaceIndex: index
    });

    assert.strictEqual(hover?.plainText, [
      '#define FIELD(T) T value;',
      'Expansion:',
      'int value;'
    ].join('\n'));
  });

  test('shows nested expansion for included function-like macro invocation hover', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const macroPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(macroPath, [
      '#define BASE(T) T value;',
      '#define WRAP(T) BASE(T) T *Find(string key) { return NULL; }'
    ].join('\n'));
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "macros.h"\nclass C { WRAP(int) };'
    });

    const hover = getHover({
      analysis,
      position: { line: 1, character: 10 },
      workspaceIndex: index
    });

    assert.ok(hover?.plainText.includes('#define WRAP(T) BASE(T) T *Find(string key) { return NULL; }'));
    assert.ok(hover?.plainText.includes('Expansion:\nint value;\nint *Find(string key) { return NULL; }'));
  });

  test('does not use later local definitions or includes for macro hover', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const macroPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(macroPath, '#define DECLARE_MEMBER(T) T includedValue;');
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: [
        'class Container { DECLARE_MEMBER(int) };',
        '#define DECLARE_MEMBER(T) T localValue;',
        '#include "macros.h"'
      ].join('\n')
    });

    const hover = getHover({
      analysis,
      position: { line: 0, character: 20 },
      workspaceIndex: index
    });

    assert.strictEqual(hover, null);
  });

  test('does not show an older matching-arity expansion after an included redefinition', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const macroPath = path.join(tempDir, 'macros.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(macroPath, '#define M(A, B) A value; B otherValue;');
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: [
        '#define M(A) A staleValue;',
        '#include "macros.h"',
        'class Container { M(int) };'
      ].join('\n')
    });

    const hover = getHover({
      analysis,
      position: { line: 2, character: 18 },
      workspaceIndex: index
    });

    assert.strictEqual(hover, null);
  });

  test('prefers a forced-include typedef over same-name type keyword hover fallback', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'typedef char * string;');

    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const markedText = '|string label;';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const hover = getHover({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assertExternalHover(hover, 'typedef string', forcedPath);
  });
});

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
