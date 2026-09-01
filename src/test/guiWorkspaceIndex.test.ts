import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { WorkspaceIndex } from '../analyzer/workspaceIndex';
import type { AnalysisGuiPart } from '../types/analysis';

suite('WorkspaceIndex GUI lookup', () => {
  test('classifies reusable GUI parts from resolved includes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-gui-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const partsPath = path.join(tempDir, 'parts.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(partsPath, 'class CommonPart : public GCWidget {};');

    const index = new WorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: [
        '#include "parts.h"',
        'class MyDialog : public GCDialog {',
        '  CommonPart part;',
        '};'
      ].join('\n')
    });

    assert.deepStrictEqual(partSummary(analysis.guiClasses[0].parts), [
      { name: 'part', typeName: 'CommonPart', path: ['part'] }
    ]);
    assert.deepStrictEqual(
      analysis.declarations
        .filter((declaration) => declaration.name === 'part')
        .map((declaration) => declaration.typeName),
      ['CommonPart']
    );
    assert.strictEqual(index.isKnownGuiClass(mainUri, 'CommonPart'), true);
  });

  test('finds forced-include GUI classes and uses them for part classification', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-gui-workspace-'));
    const forcedPath = path.join(tempDir, 'system.h');
    const mainPath = path.join(tempDir, 'main.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'class SystemPart : public GCVBoxLayout {};');

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: [
        'class MyDialog : public GCDialog {',
        '  SystemPart system;',
        '};'
      ].join('\n')
    });

    assert.deepStrictEqual(
      index.findVisibleGuiClasses(mainUri, 'SystemPart').map((guiClass) => guiClass.name),
      ['SystemPart']
    );
    assert.deepStrictEqual(partSummary(analysis.guiClasses[0].parts), [
      { name: 'system', typeName: 'SystemPart', path: ['system'] }
    ]);
    assert.deepStrictEqual(
      analysis.declarations
        .filter((declaration) => declaration.name === 'system')
        .map((declaration) => declaration.typeName),
      ['SystemPart']
    );
  });

  test('preserves transitive GUI class kind from included bases', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-gui-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const basePath = path.join(tempDir, 'base.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(basePath, 'class BaseDialog : public GCDialog {};');

    const index = new WorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: [
        '#include "base.h"',
        'class DerivedDialog : public BaseDialog {};'
      ].join('\n')
    });

    assert.deepStrictEqual(analysis.guiClasses.map((guiClass) => ({
      name: guiClass.name,
      baseName: guiClass.baseName,
      kind: guiClass.kind
    })), [{
      name: 'DerivedDialog',
      baseName: 'BaseDialog',
      kind: 'dialog'
    }]);
  });

  test('reclassifies dependent GUI parts after an included base stops being GUI', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-gui-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'parts.h');
    fs.writeFileSync(mainPath, [
      '#include "parts.h"',
      'class MyDialog : public GCDialog {',
      '  CommonPart part;',
      '};'
    ].join('\n'));
    fs.writeFileSync(headerPath, 'class CommonPart : public GCWidget {};');

    const index = new WorkspaceIndex();
    const firstAnalysis = index.indexDiskDocument(mainPath);
    fs.writeFileSync(headerPath, 'class CommonPart {};');
    index.invalidateFile(headerPath);
    const secondAnalysis = index.indexDiskDocument(mainPath);

    assert.deepStrictEqual(partSummary(firstAnalysis.guiClasses[0].parts), [
      { name: 'part', typeName: 'CommonPart', path: ['part'] }
    ]);
    assert.deepStrictEqual(partSummary(secondAnalysis.guiClasses[0].parts), []);
  });

  test('terminates include cycles when collecting visible GUI classes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-gui-workspace-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'parts.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(mainPath, '#include "parts.h"\nclass MainDialog : public GCDialog {};');
    fs.writeFileSync(headerPath, '#include "main.axl"\nclass CyclicPart : public GCWidget {};');

    const index = new WorkspaceIndex();
    index.indexDiskDocument(mainPath);

    assert.deepStrictEqual(
      index.findVisibleGuiClasses(mainUri, 'CyclicPart').map((guiClass) => guiClass.name),
      ['CyclicPart']
    );
  });

  test('returns ambiguous GUI classes deterministically by URI and range', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-gui-workspace-'));
    const forcedDir = path.join(tempDir, 'forced');
    const mainPath = path.join(tempDir, 'main.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.mkdirSync(forcedDir);
    const firstPath = path.join(forcedDir, 'a.h');
    const secondPath = path.join(forcedDir, 'b.h');
    fs.writeFileSync(firstPath, 'class SharedPart : public GCWidget {};');
    fs.writeFileSync(secondPath, '\nclass SharedPart : public GCVBoxLayout {};');

    const index = new WorkspaceIndex({ forcedIncludeRoots: [forcedDir] });
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: 'class DerivedPart : public SharedPart {};'
    });

    assert.deepStrictEqual(
      index.findVisibleGuiClasses(mainUri, 'SharedPart').map((guiClass) => ({
        name: guiClass.name,
        baseName: guiClass.baseName
      })),
      [
        { name: 'SharedPart', baseName: 'GCWidget' },
        { name: 'SharedPart', baseName: 'GCVBoxLayout' }
      ]
    );
    assert.strictEqual(index.findGuiClass(mainUri, 'SharedPart')?.baseName, 'GCWidget');
    assert.strictEqual(analysis.guiClasses[0].kind, 'widget');
  });
});

function partSummary(parts: AnalysisGuiPart[]): { name?: string; typeName: string; path: string[] }[] {
  return parts.map((part) => ({
    name: part.name,
    typeName: part.typeName,
    path: part.path
  }));
}
