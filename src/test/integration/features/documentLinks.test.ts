import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { runAnalysisSteps, runAnalysisStepsAsync } from '../../../util/analysisSteps';
import { getDefinitions } from '../../../analyzer/navigation';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('R2 document link analysis', () => {
  const fixtures = useWorkspaceFixtures();
  test('matches definition search order for quoted/angle includes and extensionless scripts', () => {
    const root = fixtures.createTempDir();
    const source = path.join(root, 'local');
    const external = path.join(root, 'external');
    fs.mkdirSync(source); fs.mkdirSync(external);
    for (const directory of [source, external]) {
      fs.writeFileSync(path.join(directory, 'api.h'), '');
      fs.writeFileSync(path.join(directory, 'run.axl'), '');
    }
    fs.writeFileSync(path.join(source, 'run'), '');
    const index = fixtures.createWorkspaceIndex({ includeRoots: [external] });
    const input = { uri: pathToFileURL(path.join(source, 'main.axl')).href, version: 1,
      text: '#include "api.h"\n#include <api.h>\nvoid main() { @run; }' };
    const links = runAnalysisSteps(index.getDocumentLinksSteps(input));
    const targets = links.map(link => index.resolveDocumentLink(input.uri, link));
    assert.deepStrictEqual(targets, [pathToFileURL(path.join(source, 'api.h')).href,
      pathToFileURL(path.join(external, 'api.h')).href, pathToFileURL(path.join(source, 'run')).href]);
    const analysis = index.analyzeDocument(input);
    assert.deepStrictEqual(links.map(link => getDefinitions({ analysis, position: link.range.start, workspaceIndex: index })[0]?.uri), targets);
  });

  test('skips directories when resolving includes and extensionless scripts', () => {
    const root = fixtures.createTempDir();
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    fs.mkdirSync(path.join(root, 'api.h'));
    fs.mkdirSync(path.join(root, 'run'));
    fs.writeFileSync(path.join(external, 'api.h'), '');
    fs.writeFileSync(path.join(root, 'run.axl'), '');
    const index = fixtures.createWorkspaceIndex({ includeRoots: [external] });
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).href, version: 1,
      text: '#include "api.h"\nvoid main() { @run; }' };
    const links = runAnalysisSteps(index.getDocumentLinksSteps(input));
    assert.deepStrictEqual(links.map(link => index.resolveDocumentLink(input.uri, link)), [
      pathToFileURL(path.join(external, 'api.h')).href, pathToFileURL(path.join(root, 'run.axl')).href
    ]);
    const analysis = index.analyzeDocument(input);
    assert.deepStrictEqual(links.map(link => getDefinitions({ analysis, position: link.range.start, workspaceIndex: index })[0]?.uri),
      links.map(link => index.resolveDocumentLink(input.uri, link)));
  });

  test('resolves an absolute script path with Windows URI encoding', () => {
    const root = fixtures.createTempDir();
    const target = path.join(fs.realpathSync.native(root), 'run.axl');
    fs.writeFileSync(target, '');
    const index = fixtures.createWorkspaceIndex();
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).href, version: 1,
      text: 'void main() { @' + target.replace(/\\/g, '/') + '; }' };
    const links = runAnalysisSteps(index.getDocumentLinksSteps(input));
    assert.strictEqual(links.length, 1);
    assert.strictEqual(index.resolveDocumentLink(input.uri, links[0]), pathToFileURL(target).href);
  });

  test('does not analyze source semantics, linked targets, forced includes or login', () => {
    const root = fixtures.createTempDir();
    const target = path.join(root, 'api.h');
    const forced = path.join(root, 'forced.h');
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(target, 'int included;');
    fs.writeFileSync(forced, 'int forced;');
    fs.writeFileSync(path.join(root, 'bin', '_login.axl'), 'int login;');
    const index = fixtures.createWorkspaceIndex({ sxmHome: root, forcedIncludeFiles: [forced] });
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).href, version: 1, text: '#include "api.h"' };
    const links = runAnalysisSteps(index.getDocumentLinksSteps(input));
    assert.strictEqual(index.resolveDocumentLink(input.uri, links[0]), pathToFileURL(target).href);
    for (const uri of [input.uri, pathToFileURL(target).href, pathToFileURL(forced).href, pathToFileURL(path.join(root, 'bin', '_login.axl')).href]) {
      assert.strictEqual(index.getAnalyzedDocument(uri), undefined);
    }
    assert.deepStrictEqual(runAnalysisSteps(index.getDocumentLinksSteps(input)), links);
    index.deleteDocument(input.uri);
    assert.deepStrictEqual(runAnalysisSteps(index.getDocumentLinksSteps({ ...input, text: '' })), []);
  });

  test('uses UTF-16 ranges and never treats dynamic or quoted command arguments as scripts', () => {
    const analyzer = new DocumentAnalyzer();
    const text = 'void main() { /*日本😀*/ @run; @\x60name\x60 argument; @"quoted name" argument; }';
    const items = runAnalysisSteps(analyzer.getDocumentLinksSteps({ uri: 'file:///main.axl', version: 1, text }));
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].range, { start: { line: 0, character: 24 }, end: { line: 0, character: 27 } });
    assert.deepStrictEqual(runAnalysisSteps(analyzer.getDocumentLinksSteps({
      uri: 'file:///main.axl', version: 2, text: '/* unclosed\n#include "fake.h"\nvoid main() { @fake; }'
    })), []);
  });

  test('returns each nested command once', () => {
    const analyzer = new DocumentAnalyzer();
    const items = runAnalysisSteps(analyzer.getDocumentLinksSteps({
      uri: 'file:///main.axl', version: 1, text: 'void main(){ @outer \x60foo({ @inner; })\x60; }'
    }));
    assert.deepStrictEqual(items.map(item => item.path), ['outer', 'inner']);
  });

  test('cancellation leaves no partial result and a subsequent request completes', async () => {
    const analyzer = new DocumentAnalyzer();
    const input = { uri: 'file:///large.axl', version: 1, text: 'void main() {\n' + '@run;\n'.repeat(2000) + '}' };
    const source = new CancellationTokenSource();
    let checkpoints = 0;
    await assert.rejects(runAnalysisStepsAsync(analyzer.getDocumentLinksSteps(input), source.token, () => {
      if (++checkpoints === 4) { source.cancel(); }
    }), (error: {code: number}) => error.code === LSPErrorCodes.RequestCancelled);
    source.dispose();
    assert.strictEqual(runAnalysisSteps(analyzer.getDocumentLinksSteps(input)).length, 2000);
  });
});
