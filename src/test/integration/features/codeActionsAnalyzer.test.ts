import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getCodeActions } from '../../../analyzer/codeActions';
import { toLspCodeActions } from '../../../lsp/codeActions';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('code action analyzer', () => {
  test('returns include quick fix for one unambiguous unknown type candidate', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class Widget {};');
    const index = createWorkspaceIndex();
    index.indexDiskDocument(headerPath);
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: 'Widget widget;'
    });

    const actions = getCodeActions({
      analysis,
      diagnostics: analysis.diagnostics,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      workspaceIndex: index
    });

    assert.deepStrictEqual(actions, [{
      title: 'Add include "types.h"',
      kind: 'quickfix',
      diagnostics: [analysis.diagnostics[0]],
      edit: {
        changes: {
          [mainUri]: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: '#include "types.h"\n'
          }]
        }
      }
    }]);

    const localized = toLspCodeActions(getCodeActions({
      analysis, diagnostics: analysis.diagnostics,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      workspaceIndex: index, locale: 'ja'
    }), 'ja');
    assert.strictEqual(localized[0].title, '"types.h" のインクルードを追加');
    assert.strictEqual(localized[0].diagnostics?.[0].message, "型'Widget'は定義されていません。");
    assert.deepStrictEqual(localized[0].edit, actions[0].edit);
  });

  test('returns no include quick fix for ambiguous candidates', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const firstPath = path.join(tempDir, 'first.h');
    const secondPath = path.join(tempDir, 'second.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(firstPath, 'class Widget {};');
    fs.writeFileSync(secondPath, 'class Widget {};');
    const index = createWorkspaceIndex();
    index.indexDiskDocument(firstPath);
    index.indexDiskDocument(secondPath);
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: 'Widget widget;'
    });

    const actions = getCodeActions({
      analysis,
      diagnostics: analysis.diagnostics,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      workspaceIndex: index
    });

    assert.deepStrictEqual(actions, []);
  });
});

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
