import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getCompletions } from '../../../analyzer/completion';
import { getHover } from '../../../analyzer/hover';
import { getDefinitions } from '../../../analyzer/navigation';
import { getRenameEdits } from '../../../analyzer/rename';
import { collectSemanticDiagnostics } from '../../../analyzer/semanticDiagnostics';
import { collectSemanticTokens } from '../../../analyzer/semanticTokens';
import { getSignatureHelp } from '../../../analyzer/signatureHelp';
import { analyzeMarked } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('functions require source declarations', () => {
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();

  test('undeclared former builtin functions have no hover or completions', () => {
    const input = { ...analyzeMarked('void main() { |printf("x"); }'), workspaceIndex: createWorkspaceIndex() };
    assert.strictEqual(getHover(input), null);
    assert.ok(!getCompletions(input).some(item => item.kind === 'function' && item.name === 'printf'));
  });

  test('undeclared former builtin calls are diagnosed and have no function token', () => {
    const { analysis, position } = analyzeMarked('void main() { |abs(-1); }');
    assert.deepStrictEqual(collectSemanticDiagnostics({ analysis }).map(item => item.message), ["Unknown identifier 'abs'."]);
    assert.ok(!collectSemanticTokens(analysis).some(token => token.range.start.character === position.character && token.tokenType === 'function'));
  });

  test('a local declaration using a former builtin name can be renamed', () => {
    const input = { ...analyzeMarked('int abs(int value); void main() { |abs(1); }'), workspaceIndex: createWorkspaceIndex() };
    const result = getRenameEdits({ ...input, newName: 'absolute' });
    assert.ok('changes' in result);
    if ('changes' in result) {
      assert.strictEqual(result.changes[input.analysis.uri].length, 2);
    }
  });

  test('uppercase typedef variables still report duplicates when shadowing a function', () => {
    const { analysis } = analyzeMarked('typedef int VALUE; int customLog(string format); void main() { VALUE customLog; VALUE |customLog; }');
    assert.deepStrictEqual(collectSemanticDiagnostics({ analysis }).map(item => item.message), ["Duplicate declaration 'customLog'."]);
  });

  for (const name of ['printf', 'customLog']) {
    test('macro-prefixed declared calls do not produce duplicates for ' + name, () => {
      const directory = createTempDir();
      const header = path.join(directory, 'functions.h');
      fs.writeFileSync(header, '#define M_DEBUG\nint ' + name + '(string format);');
      const workspaceIndex = createWorkspaceIndex({ forcedIncludeFiles: [header] });
      const analysis = workspaceIndex.indexOpenDocument({
        uri: pathToFileURL(path.join(directory, 'main.axl')).toString(), version: 1,
        text: 'void main() { M_DEBUG ' + name + '("first"); M_DEBUG ' + name + '("second"); }'
      });
      assert.deepStrictEqual(analysis.diagnostics, []);
      assert.deepStrictEqual(collectSemanticDiagnostics({ analysis, workspaceIndex }), []);
    });
  }

  test('forced includes provide function intelligence and restarting without them removes it', () => {
    const directory = createTempDir();
    const header = path.join(directory, 'functions.h');
    fs.writeFileSync(header, 'int abs(int value);');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const workspaceIndex = createWorkspaceIndex({ forcedIncludeFiles: [header] });
    const { text, position } = analyzeMarked('void main() { |abs(1); }');
    const analysis = workspaceIndex.indexOpenDocument({ uri, version: 1, text });
    const input = { analysis, text, position, workspaceIndex };
    assert.deepStrictEqual(collectSemanticDiagnostics(input), []);
    assert.ok(getHover(input)?.plainText.includes('int abs(int value)'));
    assert.ok(getCompletions({ ...input, position: { ...position, character: position.character + 2 } }).some(item => item.name === 'abs' && item.detail?.includes('int abs(int value)')));
    assert.strictEqual(getDefinitions(input)[0]?.uri, pathToFileURL(header).toString());
    assert.ok(getSignatureHelp({ ...input, position: { line: 0, character: text.indexOf('1') } }));
    assert.ok(collectSemanticTokens(analysis, workspaceIndex).some(token => token.range.start.character === position.character && token.tokenType === 'function'));
    const renamed = getRenameEdits({ ...input, newName: 'absolute' });
    assert.ok('changes' in renamed);
    if ('changes' in renamed) {
      assert.strictEqual(renamed.changes[uri].length, 1);
      assert.strictEqual(renamed.changes[pathToFileURL(header).toString()].length, 1);
    }
    const withoutIncludes = createWorkspaceIndex();
    const nextAnalysis = withoutIncludes.indexOpenDocument({ uri, version: 1, text });
    assert.strictEqual(getHover({ ...input, analysis: nextAnalysis, workspaceIndex: withoutIncludes }), null);
    assert.ok(collectSemanticDiagnostics({ analysis: nextAnalysis, workspaceIndex: withoutIncludes }).some(item => item.message === "Unknown identifier 'abs'."));
  });
});
