import process from 'node:process';
import console from 'node:console';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { WorkspaceIndex } = require('../out/analyzer/workspaceIndex');
const { DocumentAnalyzer } = require('../out/analyzer/documentAnalyzer');
const { createAxelParser } = require('../out/analyzer/axelParser');
const { visibleDeclarationsByName, declarationsInTypeHierarchy } = require('../out/analyzer/resolution');
const { collectTypeDiagnostics } = require('../out/analyzer/typeChecking/diagnostics');
const { runAnalysisSteps } = require('../out/util/analysisSteps');
const { buildTypeContext, lookupBinding } = require('../out/analyzer/typeChecking/declarations');
const { getHover } = require('../out/analyzer/hover');

const rows = [];
const digest = value => createHash('sha256').update(JSON.stringify(value).split(pathToFileURL(root).toString()).join('file:///fixture')).digest('hex');
async function measure(scenario, size, work) {
  globalThis.gc?.();
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const value = await work();
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  rows.push({ scenario, size, wallMs, cpuMs: (used.user + used.system) / 1000,
    heapDelta: after.heapUsed - before.heapUsed, rss: after.rss, resultHash: digest(value) });
  return value;
}
// Synthetic fixtures, no proprietary installation. Run each sample in a fresh process.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-benchmark-'));
try {
  for (const size of [250, 1000, 4000]) {
    const text = ['class Box { public: int member; };', ...Array.from({ length: size }, (_, i) => 'int value' + i + ';'),
      'void main() { Box box; box.member = value1; }'].join('\n');
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text };
    const parser = createAxelParser();
    await measure('parse', size, () => parser.parse(text).rootNode.hasError);
    const analyzer = new DocumentAnalyzer();
    let analysis;
    await measure('analysis', size, () => {
      analysis = analyzer.analyzeDocument(input);
      return { declarations: analysis.declarations.length, diagnostics: analysis.diagnostics };
    });
    analyzer.clear();
    const index = new WorkspaceIndex();
    await measure('workspaceDiagnostics', size, () => {
      analysis = index.indexOpenDocument(input);
      return analysis.diagnostics;
    });
    const context = buildTypeContext({ analysis, catalog: { declarationUris: new Set(), rolesByDeclaration: new Map(), analysisOnlyMacroUris: new Set() } });
    const scope = context.scopes.find(scope => !scope.parent);
    await measure('typeBindingLookup200', size, () => {
      let count = 0;
      for (let i = 0; i < 200; i++) { count += lookupBinding(context, 'value' + (i % size), scope) ? 1 : 0; }
      assert.equal(count, 200);
      return count;
    });
    const lookup = { analysis, position: { line: size + 1, character: 28 }, workspaceIndex: index };
    await measure('visibleNameLookup200', size, () => {
      let count = 0;
      for (let i = 0; i < 200; i++) { count += visibleDeclarationsByName(lookup, 'value1').length; }
      assert.equal(count, 200);
      return count;
    });
    await measure('memberLookup200', size, () => {
      let count = 0;
      for (let i = 0; i < 200; i++) { count += declarationsInTypeHierarchy(lookup, 'Box').length; }
      assert.equal(count, 200);
      return count;
    });
    await measure('hover100', size, () => {
      let result;
      for (let i = 0; i < 100; i++) { result = getHover(lookup); }
      assert.ok(result);
      return result;
    });
    await measure('semanticTokens20', size, () => {
      let tokens;
      for (let i = 0; i < 20; i++) { tokens = index.getSemanticTokens(analysis); }
      return tokens;
    });
    await measure('outline20', size, () => {
      let symbols;
      for (let i = 0; i < 20; i++) { symbols = runAnalysisSteps(index.getDocumentSymbolsSteps(input)); }
      return symbols;
    });
    await measure('edit5', size, () => {
      let result;
      for (let i = 0; i < 5; i++) {
        const edited = { ...input, version: i + 2, text: text + '\nint edited' + i + ';' };
        index.updateOpenDocument(edited);
        result = index.indexOpenDocument(edited);
      }
      return result.diagnostics;
    });
    await index.waitForBackgroundIndexing();
    index.deleteDocument(input.uri);
  }
  for (const size of [250, 1000, 4000]) {
    const header = path.join(root, 'shared.h');
    fs.writeFileSync(header, Array.from({ length: size }, (_, i) => 'int external' + i + ';').join('\n'));
    const input = { uri: pathToFileURL(path.join(root, 'consumer.axl')).toString(), version: 1,
      text: '#include "shared.h"\nvoid main() { external1 = 1; }' };
    const index = new WorkspaceIndex();
    index.indexOpenDocument(input);
    await measure('externalNameLookup200', size, () => {
      let count = 0;
      for (let i = 0; i < 200; i++) { count += index.findVisibleDeclarations(input.uri, 'external' + (i % size)).length; }
      assert.equal(count, 200);
      return count;
    });
    await index.waitForBackgroundIndexing();
    index.deleteDocument(input.uri);
  }
  for (const size of [250, 1000]) {
    const analyzer = new DocumentAnalyzer();
    const analysis = analyzer.analyzeDocument({ uri: pathToFileURL(path.join(root, 'macro.axl')).toString(), version: 1,
      text: '#define ONE 1\nvoid main(){int a;' + 'a+ONE;'.repeat(size) + '}' });
    await measure('macroTypeDiagnostics', size, () => collectTypeDiagnostics({ analysis }));
    analyzer.clear();
  }
  globalThis.gc?.();
  console.log(JSON.stringify({ schemaVersion: 1, node: process.version, platform: process.platform,
    arch: process.arch, cpu: os.cpus()[0]?.model, gc: !!globalThis.gc, rows,
    finalMemory: process.memoryUsage() }, null, 2));
} finally {
  const relative = path.relative(os.tmpdir(), root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(root, { recursive: true, force: true });
}
