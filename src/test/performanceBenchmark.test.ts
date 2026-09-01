import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { collectSemanticTokens } from '../analyzer/semanticTokens';
import { WorkspaceIndex } from '../analyzer/workspaceIndex';

suite('performance benchmark', () => {
  test('foreground open and cached semantic tokens avoid eager include indexing', async () => {
    const fixture = createBenchmarkFixture(120);
    const index = new WorkspaceIndex();

    const open = measure(() => index.analyzeForegroundDocument({
      uri: fixture.mainUri,
      version: 1,
      text: fixture.mainText
    }));
    const tokens = measure(() => collectSemanticTokens(open.value));
    const cachedOpen = measure(() => index.analyzeForegroundDocument({
      uri: fixture.mainUri,
      version: 1,
      text: fixture.mainText
    }));

    assert.strictEqual(cachedOpen.value, open.value);
    assert.deepStrictEqual(index.findDeclarations('Included119'), []);
    assert.ok(open.durationMs < 250, `foreground open took ${open.durationMs.toFixed(1)}ms`);
    assert.ok(cachedOpen.durationMs < 25, `cached foreground open took ${cachedOpen.durationMs.toFixed(1)}ms`);
    assert.ok(tokens.durationMs < 100, `semantic token collection took ${tokens.durationMs.toFixed(1)}ms`);

    await index.waitForBackgroundIndexing();
    assert.deepStrictEqual(
      index.findDeclarations('Included119').map((declaration) => declaration.name),
      ['Included119']
    );

    if (process.env.AXEL_LS_BENCHMARK === '1') {
      console.log([
        `foregroundOpenMs=${open.durationMs.toFixed(1)}`,
        `cachedOpenMs=${cachedOpen.durationMs.toFixed(1)}`,
        `semanticTokensMs=${tokens.durationMs.toFixed(1)}`
      ].join(' '));
    }
  });
});

interface TimedResult<T> {
  value: T;
  durationMs: number;
}

function measure<T>(work: () => T): TimedResult<T> {
  const startedAt = performance.now();
  const value = work();
  return {
    value,
    durationMs: performance.now() - startedAt
  };
}

function createBenchmarkFixture(includeCount: number): { mainUri: string; mainText: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-benchmark-'));
  const includes: string[] = [];
  for (let index = 0; index < includeCount; index += 1) {
    const fileName = `included${index}.h`;
    fs.writeFileSync(path.join(tempDir, fileName), [
      `class Included${index} {};`,
      `int includedValue${index};`
    ].join('\n'));
    includes.push(`#include "${fileName}"`);
  }

  const mainPath = path.join(tempDir, 'main.axl');
  const mainText = [
    ...includes,
    'class MainClass {};',
    'int mainValue;',
    'void main() {',
    '  mainValue = 1;',
    '}'
  ].join('\n');
  fs.writeFileSync(mainPath, mainText);
  return {
    mainUri: pathToFileURL(mainPath).toString(),
    mainText
  };
}
