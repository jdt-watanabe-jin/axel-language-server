import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveInclude, resolveScriptExecution } from '../analyzer/includeResolver';

suite('resolveInclude', () => {
  test('resolves quoted includes from the including file directory before APP_AXELPATH roots', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-include-'));
    const sourceDir = path.join(tempDir, 'src');
    const includeRoot = path.join(tempDir, 'include');
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(includeRoot);
    fs.writeFileSync(path.join(sourceDir, 'types.h'), 'int localType;');
    fs.writeFileSync(path.join(includeRoot, 'types.h'), 'int pathType;');

    const result = resolveInclude({
      includingFilePath: path.join(sourceDir, 'main.axl'),
      includeText: '"types.h"',
      includeRoots: [includeRoot]
    });

    assert.strictEqual(result.status, 'resolved');
    assert.strictEqual(result.filePath, path.join(sourceDir, 'types.h'));
  });

  test('resolves quoted includes from the including file parent directory before APP_AXELPATH roots', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-include-'));
    const sourceDir = path.join(tempDir, 'generated');
    const includeRoot = path.join(tempDir, 'include');
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(includeRoot);
    fs.writeFileSync(path.join(tempDir, 'types.h'), 'int parentType;');
    fs.writeFileSync(path.join(includeRoot, 'types.h'), 'int pathType;');

    const result = resolveInclude({
      includingFilePath: path.join(sourceDir, 'main.axl'),
      includeText: '"types.h"',
      includeRoots: [includeRoot]
    });

    assert.strictEqual(result.status, 'resolved');
    assert.strictEqual(result.filePath, path.join(tempDir, 'types.h'));
  });

  test('resolves angle includes from APP_AXELPATH roots without using the including file directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-include-'));
    const sourceDir = path.join(tempDir, 'src');
    const includeRoot = path.join(tempDir, 'include');
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(includeRoot);
    fs.writeFileSync(path.join(sourceDir, 'types.h'), 'int localType;');
    fs.writeFileSync(path.join(includeRoot, 'types.h'), 'int pathType;');

    const result = resolveInclude({
      includingFilePath: path.join(sourceDir, 'main.axl'),
      includeText: '<types.h>',
      includeRoots: [includeRoot]
    });

    assert.strictEqual(result.status, 'resolved');
    assert.strictEqual(result.filePath, path.join(includeRoot, 'types.h'));
  });

  test('returns an unresolved result for missing includes without throwing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-include-'));
    const result = resolveInclude({
      includingFilePath: path.join(tempDir, 'main.axl'),
      includeText: '"missing.h"',
      includeRoots: []
    });

    assert.deepStrictEqual(result, {
      status: 'unresolved',
      reason: 'not-found',
      includePath: 'missing.h',
      candidates: [
        path.join(tempDir, 'missing.h'),
        path.join(path.dirname(tempDir), 'missing.h')
      ]
    });
  });

  test('does not use the including file parent directory for script execution', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-script-'));
    const sourceDir = path.join(tempDir, 'generated');
    const includeRoot = path.join(tempDir, 'include');
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(includeRoot);
    fs.writeFileSync(path.join(tempDir, 'task.axl'), 'void parent() {}');
    fs.writeFileSync(path.join(includeRoot, 'task.axl'), 'void configured() {}');

    const result = resolveScriptExecution({
      includingFilePath: path.join(sourceDir, 'main.axl'),
      scriptPath: 'task',
      includeRoots: [includeRoot]
    });

    assert.strictEqual(result.status, 'resolved');
    assert.strictEqual(result.filePath, path.join(includeRoot, 'task.axl'));
  });
});
