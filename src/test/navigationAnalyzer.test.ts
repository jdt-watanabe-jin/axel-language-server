import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getDefinitions, getReferences } from '../analyzer/navigation';
import { DocumentAnalyzer } from '../analyzer/documentAnalyzer';
import { WorkspaceIndex } from '../analyzer/workspaceIndex';
import type { AnalysisDeclaration, AnalyzedDocument } from '../types/analysis';

suite('navigation', () => {
  test('definition on a local reference jumps to local declaration', () => {
    const { analysis, position } = analyzeMarked('void main() { int local; |local = 1; }');

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions, [{
      uri: 'file:///main.axl',
      range: {
        start: { line: 0, character: 18 },
        end: { line: 0, character: 23 }
      }
    }]);
  });

  test('definition across include jumps to included file declaration', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-navigation-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class IncludedType {};');
    const index = new WorkspaceIndex();
    const markedText = '#include "types.h"\n|IncludedType value;';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const definitions = getDefinitions({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assert.deepStrictEqual(definitions, [{
      uri: pathToFileURL(headerPath).toString(),
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 18 }
      }
    }]);
  });

  test('definition on an include path jumps to the included file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-navigation-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class IncludedType {};');
    const index = new WorkspaceIndex();
    const markedText = '#include "|types.h"\nIncludedType value;';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const definitions = getDefinitions({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assert.deepStrictEqual(definitions, [{
      uri: pathToFileURL(headerPath).toString(),
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      }
    }]);
  });

  test('definition on an AXEL execution file name jumps to the script file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-navigation-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const scriptPath = path.join(tempDir, 'test.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(scriptPath, 'void main() {}');
    const index = new WorkspaceIndex();
    const markedText = 'void main() { string infile; |@test -i `infile`; }';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const definitions = getDefinitions({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assert.deepStrictEqual(definitions, [{
      uri: pathToFileURL(scriptPath).toString(),
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      }
    }]);
  });

  test('references include declaration only when requested', () => {
    const { analysis, position } = analyzeMarked('void main() { int local; |local = local + 1; }');

    const withDeclaration = getReferences({
      analysis,
      position,
      includeDeclaration: true,
      workspaceIndex: new WorkspaceIndex()
    });
    const withoutDeclaration = getReferences({
      analysis,
      position,
      includeDeclaration: false,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(withDeclaration.map((location) => location.range.start.character), [18, 25, 33]);
    assert.deepStrictEqual(withoutDeclaration.map((location) => location.range.start.character), [25, 33]);
  });

  test('shadowed local variable resolves to nearest valid declaration', () => {
    const { analysis, position } = analyzeMarked([
      'void main() {',
      '  int value;',
      '  { int value; |value = 1; }',
      '}'
    ].join('\n'));

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions.map((location) => location.range.start), [
      { line: 2, character: 8 }
    ]);
  });

  test('definition on a GUI part member access jumps to the part declaration', () => {
    const { analysis, position } = analyzeMarked([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCText input; };',
      '};',
      'void main() { MyDialog dialog; dialog.group.|input; }'
    ].join('\n'));

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions.map((location) => location.range.start), [
      { line: 1, character: 28 }
    ]);
  });

  test('definition on a GUI receiver segment jumps to the nested part declaration', () => {
    const { analysis, position } = analyzeMarked([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCText input; };',
      '};',
      'void MyDialog::group.|input::OnChanged() {}'
    ].join('\n'));

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions.map((location) => location.range.start), [
      { line: 1, character: 28 }
    ]);
  });

  test('definition resolves inherited methods without matching same-name globals', () => {
    const { analysis, position } = analyzeMarked([
      'int inherited() {}',
      'class Base { void inherited() {} };',
      'class Child : public Base {};',
      'void main() { Child child; child.|inherited(); }'
    ].join('\n'));

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions.map((location) => location.range.start), [
      { line: 1, character: 18 }
    ]);
  });

  test('definition resolves this arrow member access inside an out-of-class method body', () => {
    const { analysis, position } = analyzeMarked([
      'class Widget {',
      '  int value;',
      '  void update();',
      '};',
      'void Widget::update() { this->|value = 1; }'
    ].join('\n'));

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions.map((location) => location.range.start), [
      { line: 1, character: 6 }
    ]);
  });

  test('definition on a static qualified method call jumps to the class member', () => {
    const { analysis, position } = analyzeMarked([
      'class FILE { static int IsDirectory(string path) {} };',
      'void main() { FILE::|IsDirectory("x"); }'
    ].join('\n'));

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions.map((location) => location.range.start), [
      { line: 0, character: 24 }
    ]);
  });

  test('definition on a static qualified receiver jumps to the class declaration', () => {
    const { analysis, position } = analyzeMarked([
      'class myDlg { static void DoModless() {} };',
      'void main() { |myDlg::DoModless(); }'
    ].join('\n'));

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions.map((location) => location.range.start), [
      { line: 0, character: 6 }
    ]);
  });

  test('definition on a static qualified method jumps to a malformed forced include class member', () => {
    const fixture = recoveredStaticMemberFixture();

    const definitions = getDefinitions({
      analysis: fixture.analysis,
      position: { line: 0, character: 20 },
      workspaceIndex: fixture.workspaceIndex
    });

    assert.deepStrictEqual(definitions, [{
      uri: 'file:///file.h',
      range: {
        start: { line: 5, character: 13 },
        end: { line: 5, character: 24 }
      }
    }]);
  });

  test('references collect matching cross-file method calls only from visible files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-navigation-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'widget.h');
    const unrelatedPath = path.join(tempDir, 'unrelated.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, [
      'class Widget { void run() {} };',
      'void headerUse() { Widget widget; widget.run(); }'
    ].join('\n'));
    const index = new WorkspaceIndex();
    index.indexOpenDocument({
      uri: pathToFileURL(unrelatedPath).toString(),
      version: 1,
      text: 'void run() {} void unrelated() { run(); }'
    });
    const markedText = '#include "widget.h"\nvoid main() { Widget widget; widget.|run(); }';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const references = getReferences({
      analysis,
      position: positionFromOffset(text, markerOffset),
      includeDeclaration: false,
      workspaceIndex: index
    });

    assert.deepStrictEqual(references.map((location) => ({
      uri: location.uri,
      start: location.range.start
    })), [
      {
        uri: mainUri,
        start: { line: 1, character: 36 }
      },
      {
        uri: pathToFileURL(headerPath).toString(),
        start: { line: 1, character: 41 }
      }
    ]);
  });

  test('references for a global function do not include same-name member calls', () => {
    const { analysis, position } = analyzeMarked([
      'void |run() {}',
      'class Widget { void run() {} };',
      'void main() { Widget widget; widget.run(); run(); }'
    ].join('\n'));

    const references = getReferences({
      analysis,
      position,
      includeDeclaration: true,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(references.map((location) => location.range.start), [
      { line: 0, character: 5 },
      { line: 2, character: 43 }
    ]);
  });

  test('references from an included declaration include dependent source files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-navigation-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'widget.h');
    const mainUri = pathToFileURL(mainPath).toString();
    const headerUri = pathToFileURL(headerPath).toString();
    fs.writeFileSync(headerPath, 'class Widget {};');
    const index = new WorkspaceIndex();
    index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "widget.h"\nWidget widget;'
    });
    const headerAnalysis = index.getAnalyzedDocument(headerUri);
    if (headerAnalysis === undefined) {
      throw new Error('Expected included header to be indexed.');
    }

    const references = getReferences({
      analysis: headerAnalysis,
      position: { line: 0, character: 6 },
      includeDeclaration: true,
      workspaceIndex: index
    });

    assert.deepStrictEqual(references.map((location) => ({
      uri: location.uri,
      start: location.range.start
    })), [
      {
        uri: mainUri,
        start: { line: 1, character: 0 }
      },
      {
        uri: headerUri,
        start: { line: 0, character: 6 }
      }
    ]);
  });

  test('references from one includer include sibling files that share the declaration include', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-navigation-'));
    const firstPath = path.join(tempDir, 'first.axl');
    const secondPath = path.join(tempDir, 'second.axl');
    const headerPath = path.join(tempDir, 'shared.h');
    const firstUri = pathToFileURL(firstPath).toString();
    const secondUri = pathToFileURL(secondPath).toString();
    fs.writeFileSync(headerPath, 'class Shared {};');
    const index = new WorkspaceIndex();
    const markedText = '#include "shared.h"\n|Shared first;';
    const markerOffset = markedText.indexOf('|');
    const firstText = markedText.replace('|', '');
    const firstAnalysis = index.indexOpenDocument({
      uri: firstUri,
      version: 1,
      text: firstText
    });
    index.indexOpenDocument({
      uri: secondUri,
      version: 1,
      text: '#include "shared.h"\nShared second;'
    });

    const references = getReferences({
      analysis: firstAnalysis,
      position: positionFromOffset(firstText, markerOffset),
      includeDeclaration: false,
      workspaceIndex: index
    });

    assert.deepStrictEqual(references.map((location) => ({
      uri: location.uri,
      start: location.range.start
    })), [
      {
        uri: firstUri,
        start: { line: 1, character: 0 }
      },
      {
        uri: secondUri,
        start: { line: 1, character: 0 }
      }
    ]);
  });

  test('references include all indexed files that share a forced include declaration', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-navigation-'));
    const firstPath = path.join(tempDir, 'first.axl');
    const secondPath = path.join(tempDir, 'second.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const firstUri = pathToFileURL(firstPath).toString();
    const secondUri = pathToFileURL(secondPath).toString();
    fs.writeFileSync(forcedPath, 'class Forced {};');
    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const markedText = '|Forced first;';
    const markerOffset = markedText.indexOf('|');
    const firstText = markedText.replace('|', '');
    const firstAnalysis = index.indexOpenDocument({
      uri: firstUri,
      version: 1,
      text: firstText
    });
    index.indexOpenDocument({
      uri: secondUri,
      version: 1,
      text: 'Forced second;'
    });

    const references = getReferences({
      analysis: firstAnalysis,
      position: positionFromOffset(firstText, markerOffset),
      includeDeclaration: false,
      workspaceIndex: index
    });

    assert.deepStrictEqual(references.map((location) => ({
      uri: location.uri,
      start: location.range.start
    })), [
      {
        uri: firstUri,
        start: { line: 0, character: 0 }
      },
      {
        uri: secondUri,
        start: { line: 0, character: 0 }
      }
    ]);
  });

  test('definition on a GUI event name jumps to the handler declaration', () => {
    const { analysis, position } = analyzeMarked([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCPushButton button; };',
      '};',
      'void MyDialog::group.button::|OnPush() {}'
    ].join('\n'));

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions.map((location) => location.range.start), [
      { line: 3, character: 29 }
    ]);
  });

  test('definition on an inherited inline GUI event jumps to the receiver type member', () => {
    const { analysis, position } = analyzeMarked([
      'class GCWidget { void OnCreate() {} };',
      'class GCButtonGroup : public GCWidget {};',
      'class mydialog : public GCDialog {',
      '  GCButtonGroup { |OnCreate() {} };',
      '};'
    ].join('\n'));

    const definitions = getDefinitions({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(definitions.map((location) => location.range.start), [
      { line: 1, character: 6 }
    ]);
  });

  test('definition on an included GUI part uses the owning GUI class document', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-navigation-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const firstPath = path.join(tempDir, 'a.h');
    const secondPath = path.join(tempDir, 'b.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(firstPath, [
      'class FirstDialog : public GCDialog {',
      '  GCText input;',
      '};'
    ].join('\n'));
    fs.writeFileSync(secondPath, [
      'class SecondDialog : public GCDialog {',
      '  GCText input;',
      '};'
    ].join('\n'));
    const markedText = [
      '#include "a.h"',
      '#include "b.h"',
      'void SecondDialog::|input::OnChanged() {}'
    ].join('\n');
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const index = new WorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const definitions = getDefinitions({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assert.deepStrictEqual(definitions, [{
      uri: pathToFileURL(secondPath).toString(),
      range: {
        start: { line: 1, character: 9 },
        end: { line: 1, character: 14 }
      }
    }]);
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

function recoveredStaticMemberFixture(): {
  analysis: AnalyzedDocument;
  workspaceIndex: {
    findVisibleDeclarations(sourceUri: string, name: string): AnalysisDeclaration[];
    listVisibleDeclarations(sourceUri: string): AnalysisDeclaration[];
  };
} {
  const mainUri = 'file:///main.axl';
  const headerUri = 'file:///file.h';
  const declarations: AnalysisDeclaration[] = [
    {
      id: `${headerUri}#0:6:FILE`,
      name: 'FILE',
      kind: 'class',
      uri: headerUri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      detail: 'class'
    },
    {
      id: `${headerUri}#5:13:IsDirectory`,
      name: 'IsDirectory',
      kind: 'function',
      uri: headerUri,
      range: { start: { line: 5, character: 2 }, end: { line: 5, character: 38 } },
      selectionRange: { start: { line: 5, character: 13 }, end: { line: 5, character: 24 } },
      detail: 'static int IsDirectory(string fname)'
    }
  ];

  return {
    analysis: {
      uri: mainUri,
      version: 1,
      diagnostics: [],
      symbols: [],
      declarations: [],
      references: [{
        name: 'IsDirectory',
        uri: mainUri,
        range: { start: { line: 0, character: 20 }, end: { line: 0, character: 31 } },
        call: true,
        memberAccess: {
          receiverName: 'FILE',
          memberNames: ['IsDirectory']
        }
      }],
      scopes: [],
      includes: [],
      scriptExecutions: [],
      guiClasses: [],
      guiMethods: []
    },
    workspaceIndex: {
      findVisibleDeclarations(_sourceUri: string, name: string): AnalysisDeclaration[] {
        return declarations.filter((declaration) => declaration.name === name);
      },
      listVisibleDeclarations(): AnalysisDeclaration[] {
        return declarations;
      }
    }
  };
}

function positionFromOffset(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}
