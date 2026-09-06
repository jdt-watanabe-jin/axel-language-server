import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createAxelParser } from '../../analyzer/axelParser';
import { collectSemanticTokens } from '../../analyzer/semanticTokens';
import { buildSymbolIndex } from '../../analyzer/symbolIndex';
import type { AnalysisDeclaration, AnalysisReference, AnalyzedDocument } from '../../types/analysis';
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
    let visibleDeclarationScans = 0;
    const iterateDeclarations = visibleDeclarations[Symbol.iterator].bind(visibleDeclarations);
    visibleDeclarations[Symbol.iterator] = function () {
      visibleDeclarationScans += 1;
      return iterateDeclarations();
    };
    const analysis = createGuiReferenceHeavyAnalysis(300);
    let listVisibleDeclarationCalls = 0;

    const tokens = measure(() => collectSemanticTokens(analysis, {
      listVisibleDeclarations: () => {
        listVisibleDeclarationCalls += 1;
        return visibleDeclarations;
      }
    }));

    assert.strictEqual(tokens.value.length, 2);
    assert.ok(visibleDeclarationScans <= 3, `scanned visible declarations ${visibleDeclarationScans} times`);
    assert.ok(listVisibleDeclarationCalls <= 3, `listed visible declarations ${listVisibleDeclarationCalls} times`);
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

function createVisibleEnumMemberDeclarations(memberCount: number): AnalysisDeclaration[] {
  const declarations: AnalysisDeclaration[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    declarations.push({
      id: `file:///messages.hh#${index}:2:MD_MESSAGE_${index}`,
      name: `MD_MESSAGE_${index}`,
      kind: 'enumMember',
      uri: 'file:///messages.hh',
      range: {
        start: { line: index, character: 0 },
        end: { line: index, character: 24 }
      },
      selectionRange: {
        start: { line: index, character: 2 },
        end: { line: index, character: 14 }
      },
      detail: `enum MessageId::MD_MESSAGE_${index}`,
      containerName: 'MessageId'
    });
  }
  return declarations;
}

function createReferenceHeavyAnalysis(referenceCount: number): AnalyzedDocument {
  const references: AnalysisReference[] = [];
  for (let index = 0; index < referenceCount; index += 1) {
    references.push({
      name: `MD_MESSAGE_${index}`,
      uri: 'file:///main.axl',
      range: {
        start: { line: index, character: 10 },
        end: { line: index, character: 22 }
      }
    });
  }

  return {
    uri: 'file:///main.axl',
    version: 1,
    diagnostics: [],
    symbols: [],
    declarations: [],
    references,
    macroDefinitions: [],
    macroInvocations: [],
    semanticTokenReferences: [],
    semanticTokens: [],
    scopes: [{
      id: 'global',
      range: {
        start: { line: 0, character: 0 },
        end: { line: referenceCount, character: 0 }
      },
      declarationIds: []
    }],
    includes: [],
    scriptExecutions: [],
    guiClasses: [],
    guiMethods: [],
    inactiveRanges: []
  };
}

function createGuiReferenceHeavyAnalysis(referenceCount: number): AnalyzedDocument {
  const references: AnalysisReference[] = [];
  for (let index = 0; index < referenceCount; index += 1) {
    references.push({
      name: `unknown_${index}`,
      uri: 'file:///main.axl',
      range: {
        start: { line: index + 1, character: 2 },
        end: { line: index + 1, character: 11 }
      }
    });
  }

  const classRange = {
    start: { line: 0, character: 0 },
    end: { line: referenceCount + 100, character: 0 }
  };
  const methodRange = {
    start: { line: 1, character: 0 },
    end: { line: referenceCount + 50, character: 0 }
  };

  return {
    uri: 'file:///main.axl',
    version: 1,
    diagnostics: [],
    symbols: [],
    declarations: [{
      id: 'file:///main.axl#0:6:Dialog',
      name: 'Dialog',
      kind: 'class',
      uri: 'file:///main.axl',
      range: classRange,
      selectionRange: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 12 }
      },
      detail: 'class',
      baseName: 'GCDialog'
    }],
    references,
    macroDefinitions: [],
    macroInvocations: [],
    semanticTokenReferences: [],
    semanticTokens: [],
    scopes: [{
      id: 'global',
      range: classRange,
      declarationIds: ['file:///main.axl#0:6:Dialog']
    }],
    includes: [],
    scriptExecutions: [],
    guiClasses: [{
      name: 'Dialog',
      baseName: 'GCDialog',
      kind: 'dialog',
      range: classRange,
      parts: [],
      methods: [{
        name: 'OnCreate',
        receiverPath: ['Dialog', 'OnCreate'],
        selectionRange: {
          start: { line: 0, character: 14 },
          end: { line: 0, character: 22 }
        },
        event: true,
        range: methodRange
      }]
    }],
    guiMethods: [],
    inactiveRanges: []
  };
}

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
