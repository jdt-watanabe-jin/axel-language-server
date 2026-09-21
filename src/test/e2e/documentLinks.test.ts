import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { LSPErrorCodes, type DocumentLink, type InitializeResult } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';

suite('R2 document links over stdio', function () {
  this.timeout(20_000);
  const fixtures = useWorkspaceFixtures();
  let server: ReturnType<typeof startLspServer>;
  let root: string;
  let uri: string;
  setup(() => { root = fixtures.createTempDir(); uri = pathToFileURL(path.join(root, 'main.axl')).href; server = startLspServer(15_000); });
  teardown(async () => { await server.stop(); });
  function file(name: string) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    return pathToFileURL(target).href;
  }
  async function initialize(lazy = true, configuration: unknown = {}) {
    const result = await server.request<InitializeResult>('initialize', {
      processId: null, rootUri: pathToFileURL(root).href,
      capabilities: { textDocument: lazy ? { documentLink: {} } : {} }, configuration
    });
    await server.notify('initialized', {});
    return result;
  }
  async function open(text: string, version = 1) {
    await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version, text } });
  }
  const links = () => server.request<DocumentLink[]>('textDocument/documentLink', { textDocument: { uri } });
  const resolve = (link: DocumentLink) => server.request<DocumentLink>('documentLink/resolve', link);

  test('links include paths and @ script names, excluding delimiters, arguments and comments', async () => {
    const include = file('space dir/api.h');
    const script = file('scripts/run.axl');
    const result = await initialize();
    assert.deepStrictEqual(result.capabilities.documentLinkProvider, { resolveProvider: true });
    assert.strictEqual(result.capabilities.colorProvider, undefined);
    await open('#include "space dir/api.h"\nvoid main() {\n@scripts/run value @argument;\n// @ignored;\n}');
    const items = await links();
    assert.deepStrictEqual(items.map(item => item.range), [
      { start: { line: 0, character: 10 }, end: { line: 0, character: 25 } },
      { start: { line: 2, character: 1 }, end: { line: 2, character: 12 } }
    ]);
    assert.deepStrictEqual(await Promise.all(items.map(async item => (await resolve(item)).target)), [include, script]);
  });

  test('returns eager targets for a client without documentLink support', async () => {
    const target = file('run.axl');
    await initialize(false);
    await open('void main() {\n@run;\n@missing;\n}');
    const items = await links();
    assert.deepStrictEqual(items.map(item => item.target), [target]);
    assert.ok(items.every(item => item.data === undefined));
  });

  test('keeps unresolved literal links without inventing a target and rechecks deleted files', async () => {
    file('run.axl');
    await initialize();
    await open('void main() {\n@run;\n@missing;\n}');
    const items = await links();
    assert.strictEqual(items.length, 2);
    assert.ok(items.every(item => item.target === undefined));
    fs.unlinkSync(path.join(root, 'run.axl'));
    assert.strictEqual((await resolve(items[0])).target, undefined);
    assert.strictEqual((await resolve(items[1])).target, undefined);
  });

  test('rejects links after edits and close/reopen even when the version is reused', async () => {
    file('run.axl');
    await initialize();
    await open('void main() { @run; }');
    const old = (await links())[0];
    await server.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'void main() { @other; }' }] });
    await assert.rejects(resolve(old), (error: {code: number}) => error.code === LSPErrorCodes.ContentModified);
    const edited = (await links())[0];
    await server.notify('textDocument/didClose', { textDocument: { uri } });
    await open('void main() { @run; }', 2);
    await assert.rejects(resolve(edited), (error: {code: number}) => error.code === LSPErrorCodes.ContentModified);
  });

  test('invalidates links on configuration change and uses the new search roots', async () => {
    const first = file('first/run.axl');
    const second = file('second/run.axl');
    await initialize(true, { includeRoots: [path.join(root, 'first')] });
    await open('void main() { @run; }');
    const old = (await links())[0];
    assert.strictEqual((await resolve(old)).target, first);
    await server.configure({ settings: { includeRoots: [path.join(root, 'second')] } });
    const fresh = (await links())[0];
    await assert.rejects(resolve(old), (error: {code: number}) => error.code === LSPErrorCodes.ContentModified);
    assert.strictEqual((await resolve(fresh)).target, second);
  });

  test('uses literal paths in inactive branches without linking dynamic commands or macro includes', async () => {
    const target = file('run.axl');
    await initialize();
    await open('#include HEADER\nvoid main() {\n#if 0\n@run;\n#endif\n@\x60name\x60 run;\n}');
    const items = await links();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].range.start.line, 3);
    assert.strictEqual((await resolve(items[0])).target, target);
  });

  test('retains links when another document is opened, edited and closed', async () => {
    const target = file('run.axl');
    await initialize();
    await open('void main() { @run; }');
    const item = (await links())[0];
    const other = pathToFileURL(path.join(root, 'other.axl')).href;
    await server.notify('textDocument/didOpen', { textDocument: { uri: other, languageId: 'axel', version: 1, text: '' } });
    await server.notify('textDocument/didChange', { textDocument: { uri: other, version: 2 }, contentChanges: [{ text: 'int value;' }] });
    await server.notify('textDocument/didClose', { textDocument: { uri: other } });
    assert.strictEqual((await resolve(item)).target, target);
  });

  test('does not trust client supplied targets, paths or out-of-range indices', async () => {
    const target = file('run.axl');
    await initialize();
    await open('void main() { @run; }');
    const item = (await links())[0];
    assert.strictEqual((await resolve({ ...item, target: 'file:///wrong.axl' })).target, target);
    await assert.rejects(resolve({ ...item, data: { ...item.data, index: 999 } }));
  });
});
