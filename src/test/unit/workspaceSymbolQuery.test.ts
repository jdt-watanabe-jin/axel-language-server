import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { searchWorkspaceSymbols } from '../../analyzer/workspaceSymbols/query';
import { normalizeWorkspaceSymbolSettings } from '../../analyzer/workspaceSymbols/config';
import type { WorkspaceSymbolEntry } from '../../analyzer/workspaceSymbols/model';

suite('Workspace Symbol query', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };
  const entry = (name: string, uri = `file:///${name}.axl`): WorkspaceSymbolEntry => ({
    name, qualifiedName: name, kind: 'function', uri, selectionRange: range
  });
  test('ranks matches and searches qualified names without case sensitivity', async () => {
    const entries = ['remake', 'makeMore', 'make', 'myAwesomeKindExample'].map(name => entry(name));
    assert.deepStrictEqual((await searchWorkspaceSymbols(entries, ' MAKE ', CancellationToken.None)).map(x => x.name),
      ['make', 'makeMore', 'remake', 'myAwesomeKindExample']);
    assert.strictEqual((await searchWorkspaceSymbols([{ ...entry('makeVersion'), qualifiedName: 'Version::makeVersion' }],
      'version::make', CancellationToken.None)).length, 1);
    assert.strictEqual((await searchWorkspaceSymbols([entry('makeVersion')], 'mkv', CancellationToken.None)).length, 1);
    assert.strictEqual((await searchWorkspaceSymbols([entry('makeVersion')], 'vkm', CancellationToken.None)).length, 0);
  });
  test('returns all empty-query matches, deduplicates physical targets and preserves distinct declarations', async () => {
    const a = entry('a');
    assert.deepStrictEqual((await searchWorkspaceSymbols([entry('z'), a, a, entry('a', 'file:///b.axl')], ' ', CancellationToken.None))
      .map(x => [x.name, x.uri]), [['a', 'file:///a.axl'], ['a', 'file:///b.axl'], ['z', 'file:///z.axl']]);
  });
  test('rejects cancellation instead of returning success', async () => {
    const source = new CancellationTokenSource(); source.cancel();
    try { await assert.rejects(searchWorkspaceSymbols([entry('a')], '', source.token),
      (e: unknown) => (e as { code: number }).code === LSPErrorCodes.RequestCancelled); }
    finally { source.dispose(); }
  });
  test('normalizes shared project defaults without implicit exclusions', () => {
    assert.deepStrictEqual(normalizeWorkspaceSymbolSettings({}).project, { include: ['**/*'], exclude: [] });
    assert.deepStrictEqual(normalizeWorkspaceSymbolSettings({ project: { include: [], exclude: ['generated'] } }).project,
      { include: [], exclude: ['generated'] });
  });
});
