import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getCompletions } from '../analyzer/completion';
import { WorkspaceIndex } from '../analyzer/workspaceIndex';
import { createInitializeResult } from '../lsp/capabilities';
import { toLspCompletionItem } from '../lsp/completion';
import { CompletionItemKind, TextEdit } from 'vscode-languageserver/node';

suite('AXEL command completion', () => {
  let tempDir: string;
  let sourceDir: string;
  let firstRoot: string;
  let secondRoot: string;
  let sourceUri: string;
  let index: WorkspaceIndex;
  let version: number;

  setup(() => {
    version = 0;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-command-completion-'));
    sourceDir = path.join(tempDir, 'source');
    firstRoot = path.join(tempDir, 'first');
    secondRoot = path.join(tempDir, 'second');
    for (const dir of [sourceDir, firstRoot, secondRoot]) {
      fs.mkdirSync(dir);
    }
    sourceUri = pathToFileURL(path.join(sourceDir, 'main.axl')).toString();
    index = new WorkspaceIndex({ includeRoots: [firstRoot, secondRoot] });
  });

  teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function complete(markedText: string) {
    const offset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const lines = text.slice(0, offset).split('\n');
    const position = { line: lines.length - 1, character: lines.at(-1)!.length };
    const analysis = index.indexOpenDocument({ uri: sourceUri, version: ++version, text });
    return getCompletions({ analysis, text, position, workspaceIndex: index }).map(toLspCompletionItem);
  }

  test('advertises command and directory completion triggers', () => {
    const triggers = createInitializeResult().capabilities.completionProvider!.triggerCharacters!;
    for (const character of ['@', '/', '\\']) {
      assert.ok(triggers.includes(character), `Missing trigger ${character}`);
    }
  });

  for (const source of ['@|', '  @|', 'void main() {\n\t@|\n}', 'void main() { @| }', 'void main() { int n; @| }']) {
    test(`completes command files at ${JSON.stringify(source)}`, () => {
      fs.writeFileSync(path.join(firstRoot, 'task.axl'), '');
      fs.writeFileSync(path.join(firstRoot, 'types.h'), '');
      fs.writeFileSync(path.join(firstRoot, 'notes.txt'), '');
      assert.deepStrictEqual(complete(source).map(item => item.label), ['task.axl']);
    });
  }

  test('preserves search root priority and removes duplicate command names', () => {
    fs.writeFileSync(path.join(sourceDir, 'z-local.axl'), '');
    fs.writeFileSync(path.join(firstRoot, 'm-first.axl'), '');
    fs.writeFileSync(path.join(secondRoot, 'a-second.axl'), '');
    for (const dir of [sourceDir, firstRoot, secondRoot]) {
      fs.writeFileSync(path.join(dir, 'shared.axl'), '');
    }
    fs.writeFileSync(path.join(tempDir, 'parent.axl'), '');
    const items = complete('@|');
    const expected = ['shared.axl', 'z-local.axl', 'm-first.axl', 'a-second.axl'];
    assert.deepStrictEqual(items.map(item => item.label), expected);
    assert.deepStrictEqual([...items].sort((a, b) => a.sortText!.localeCompare(b.sortText!)).map(item => item.label), expected);
    complete('void main() {\n@shared.axl|;\n}');
    assert.strictEqual(index.resolveScriptExecutionAtPosition(sourceUri, { line: 1, character: 2 })?.filePath,
      path.join(sourceDir, 'shared.axl'));
    fs.unlinkSync(path.join(sourceDir, 'shared.axl'));
    assert.strictEqual(index.resolveScriptExecutionAtPosition(sourceUri, { line: 1, character: 2 })?.filePath,
      path.join(firstRoot, 'shared.axl'));
  });

  test('inserts a directory separator when accepting a folder', () => {
    fs.mkdirSync(path.join(firstRoot, 'tools'));
    const [item] = complete('@to|');
    assert.strictEqual(item.label, 'tools');
    assert.strictEqual(item.kind, CompletionItemKind.Folder);
    assert.deepStrictEqual(item.textEdit, TextEdit.replace({
      start: { line: 0, character: 1 }, end: { line: 0, character: 3 }
    }, 'tools/'));
  });

  test('preserves the remaining path when accepting a folder in the middle', () => {
    fs.mkdirSync(path.join(firstRoot, 'tools'));
    const [item] = complete('@to|ols/task.axl;');
    assert.deepStrictEqual(item.textEdit, TextEdit.replace({
      start: { line: 0, character: 1 }, end: { line: 0, character: 7 }
    }, 'tools/'));
  });

  // Backslashes are native path separators on Windows only.
  for (const separator of process.platform === 'win32' ? ['/', '\\'] : ['/']) {
    test(`replaces only the current path segment after ${JSON.stringify(separator)}`, () => {
      fs.mkdirSync(path.join(firstRoot, 'tools'));
      fs.writeFileSync(path.join(firstRoot, 'tools', 'task.axl'), '');
      fs.writeFileSync(path.join(firstRoot, 'tools', 'other.axl'), '');
      const [item] = complete(`  @tools${separator}task.a|xl;`);
      assert.strictEqual(item.label, 'task.axl');
      assert.strictEqual(item.filterText, 'task.axl');
      assert.deepStrictEqual(item.textEdit, TextEdit.replace({
        start: { line: 0, character: 9 }, end: { line: 0, character: 17 }
      }, 'task.axl'));
    });
  }

  test('does not offer command files after command arguments', () => {
    fs.writeFileSync(path.join(firstRoot, 'task.axl'), '');
    assert.ok(!complete('@task.axl argument |').some(item => item.label === 'task.axl'));
  });
});
