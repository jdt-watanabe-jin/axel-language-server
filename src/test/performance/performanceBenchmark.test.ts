import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createAxelParser } from '../../analyzer/axelParser';
import { collectSemanticTokens } from '../../analyzer/semanticTokens';
import { buildSymbolIndex } from '../../analyzer/symbolIndex';
import { createVisibleEnumMemberDeclarations, createReferenceHeavyAnalysis, createGuiReferenceHeavyAnalysis } from '../support/semanticTokenLoad';
import { useWorkspaceFixtures } from '../support/workspace';

suite('performance benchmark', () => {
  test('foreground open and cached semantic tokens avoid eager include indexing', async () => {
    const fixture = createBenchmarkFixture(120);
    const index = createWorkspaceIndex();

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

    assert.ok(open.durationMs < 250, `foreground open took ${open.durationMs.toFixed(1)}ms`);
    assert.ok(cachedOpen.durationMs < 25, `cached foreground open took ${cachedOpen.durationMs.toFixed(1)}ms`);
    assert.ok(tokens.durationMs < 100, `semantic token collection took ${tokens.durationMs.toFixed(1)}ms`);

    await index.waitForBackgroundIndexing();
    if (process.env.AXEL_LS_BENCHMARK === '1') {
      console.log([
        `foregroundOpenMs=${open.durationMs.toFixed(1)}`,
        `cachedOpenMs=${cachedOpen.durationMs.toFixed(1)}`,
        `semanticTokensMs=${tokens.durationMs.toFixed(1)}`
      ].join(' '));
    }
  });

  test('symbol indexing scales for enum members with adjacent comments', () => {
    const parser = createAxelParser();
    const text = createDocumentedEnumFixture(600);
    const tree = parser.parse(text);

    const symbolIndex = measure(() => buildSymbolIndex(tree.rootNode, 'file:///messages.hh'));

    assert.strictEqual(symbolIndex.value.declarations.length, 601);
    assert.strictEqual(symbolIndex.value.references.length, 0);
    assert.ok(symbolIndex.durationMs < 500, `symbol indexing took ${symbolIndex.durationMs.toFixed(1)}ms`);

    if (process.env.AXEL_LS_BENCHMARK === '1') {
      console.log(`documentedEnumSymbolIndexMs=${symbolIndex.durationMs.toFixed(1)}`);
    }
  });

  test('semantic tokens cache visible declarations by referenced name', () => {
    const visibleDeclarations = createVisibleEnumMemberDeclarations(5_000);
    const analysis = createReferenceHeavyAnalysis(800);

    const tokens = measure(() => collectSemanticTokens(analysis, {
      listVisibleDeclarations: () => visibleDeclarations
    }));

    assert.strictEqual(tokens.value.length, 800);
    assert.ok(tokens.durationMs < 100, `semantic token collection took ${tokens.durationMs.toFixed(1)}ms`);

    if (process.env.AXEL_LS_BENCHMARK === '1') {
      console.log(`visibleDeclarationSemanticTokensMs=${tokens.durationMs.toFixed(1)}`);
    }
  });

  test('semantic tokens reuse visible declarations while resolving GUI implicit members', () => {
    const visibleDeclarations = createVisibleEnumMemberDeclarations(5_000);
    const analysis = createGuiReferenceHeavyAnalysis(300);
    const tokens = measure(() => collectSemanticTokens(analysis, {
      listVisibleDeclarations: () => visibleDeclarations
    }));

    assert.strictEqual(tokens.value.length, 2);
    assert.ok(tokens.durationMs < 150, `semantic token collection took ${tokens.durationMs.toFixed(1)}ms`);

    if (process.env.AXEL_LS_BENCHMARK === '1') {
      console.log(`guiImplicitSemanticTokensMs=${tokens.durationMs.toFixed(1)}`);
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
  const tempDir = createTempDir();
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

function createDocumentedEnumFixture(memberCount: number): string {
  const lines = ['enum MessageId {'];
  for (let index = 0; index < memberCount; index += 1) {
    lines.push(`/// Message ${index}`);
    lines.push(`  MD_MESSAGE_${index} = ${index},`);
  }
  lines.push('};');
  return lines.join('\n');
}

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
