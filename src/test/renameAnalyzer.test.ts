import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getRenameEdits, prepareRename } from '../analyzer/rename';
import { DocumentAnalyzer } from '../analyzer/documentAnalyzer';
import { WorkspaceIndex } from '../analyzer/workspaceIndex';

suite('rename analyzer', () => {
  test('prepare rename succeeds on a local variable reference', () => {
    const { analysis, position } = analyzeMarked('void main() { int local; |local = 1; }');

    assert.deepStrictEqual(prepareRename({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    }), {
      start: { line: 0, character: 25 },
      end: { line: 0, character: 30 }
    });
  });

  test('prepare rename rejects built-in symbols', () => {
    const { analysis, position } = analyzeMarked('void main() { |printf("x"); }');

    assert.strictEqual(prepareRename({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    }), null);
  });

  test('rename updates all references in the current file', () => {
    const { analysis, position } = analyzeMarked('void main() { int local; |local = local + 1; }');

    const result = getRenameEdits({
      analysis,
      position,
      newName: 'renamed',
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(result, {
      changes: {
        'file:///main.axl': [
          edit(0, 18, 23, 'renamed'),
          edit(0, 25, 30, 'renamed'),
          edit(0, 33, 38, 'renamed')
        ]
      }
    });
  });

  test('rename updates references across included files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-rename-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'shared.h');
    const mainUri = pathToFileURL(mainPath).toString();
    const headerUri = pathToFileURL(headerPath).toString();
    fs.writeFileSync(headerPath, 'class Shared {};');
    const markedText = '#include "shared.h"\n|Shared first;';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const index = new WorkspaceIndex();
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });

    const result = getRenameEdits({
      analysis,
      position: positionFromOffset(text, markerOffset),
      newName: 'Renamed',
      workspaceIndex: index
    });

    assert.deepStrictEqual(result, {
      changes: {
        [mainUri]: [edit(1, 0, 6, 'Renamed')],
        [headerUri]: [edit(0, 6, 12, 'Renamed')]
      }
    });
  });

  test('rename does not update shadowed unrelated names', () => {
    const { analysis, position } = analyzeMarked([
      'void main() {',
      '  int value;',
      '  value = 1;',
      '  { int value; |value = 2; }',
      '}'
    ].join('\n'));

    const result = getRenameEdits({
      analysis,
      position,
      newName: 'inner',
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(result, {
      changes: {
        'file:///main.axl': [
          edit(3, 8, 13, 'inner'),
          edit(3, 15, 20, 'inner')
        ]
      }
    });
  });
});

function analyze(text: string) {
  return new DocumentAnalyzer().analyzeDocument({
    uri: 'file:///main.axl',
    version: 1,
    text
  });
}

function analyzeMarked(markedText: string) {
  const markerOffset = markedText.indexOf('|');
  assert.notStrictEqual(markerOffset, -1);
  const text = markedText.replace('|', '');
  return {
    analysis: analyze(text),
    position: positionFromOffset(text, markerOffset)
  };
}

function positionFromOffset(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}

function edit(line: number, start: number, end: number, newText: string) {
  return {
    range: {
      start: { line, character: start },
      end: { line, character: end }
    },
    newText
  };
}
