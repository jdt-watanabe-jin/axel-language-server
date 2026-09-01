import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getCodeActions } from '../analyzer/codeActions';
import { WorkspaceIndex } from '../analyzer/workspaceIndex';

suite('code action analyzer', () => {
  test('returns include quick fix for one unambiguous unknown type candidate', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-code-action-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class Widget {};');
    const index = new WorkspaceIndex();
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
  });

  test('returns no include quick fix for ambiguous candidates', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-code-action-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const firstPath = path.join(tempDir, 'first.h');
    const secondPath = path.join(tempDir, 'second.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(firstPath, 'class Widget {};');
    fs.writeFileSync(secondPath, 'class Widget {};');
    const index = new WorkspaceIndex();
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
