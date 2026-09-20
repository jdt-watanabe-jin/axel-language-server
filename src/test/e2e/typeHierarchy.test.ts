import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationTokenSource, LSPErrorCodes, type InitializeResult, type TypeHierarchyItem } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP stdio Type hierarchy', function () {
  this.timeout(20_000);
  let server: ReturnType<typeof startLspServer>;
  let directory: string;
  const uri = (name: string) => pathToFileURL(path.join(directory, name)).toString();
  setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-type-hierarchy-')); server = startLspServer(12_000); });
  teardown(async () => { await server.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  async function initialize(settings = {}) {
    const result = await server.request<InitializeResult>('initialize', { processId: null, rootUri: uri(''),
      capabilities: { window: { workDoneProgress: true } }, configuration: settings });
    await server.notify('initialized', {}); return result;
  }
  async function open(name: string, text: string, version = 1) {
    await server.notify('textDocument/didOpen', { textDocument: { uri: uri(name), languageId: 'axel', version, text } });
  }
  const prepare = (name: string, line: number, character: number) => server.request<TypeHierarchyItem[] | null>(
    'textDocument/prepareTypeHierarchy', { textDocument: { uri: uri(name) }, position: { line, character } });
  const supers = (item: TypeHierarchyItem) => server.request<TypeHierarchyItem[] | null>('typeHierarchy/supertypes', { item });
  const subs = (item: TypeHierarchyItem) => server.request<TypeHierarchyItem[] | null>('typeHierarchy/subtypes', { item });

  test('advertises all three requests and finds unopened derived types from a variable', async () => {
    fs.writeFileSync(path.join(directory, 'base.h'), 'class Base { int x; };');
    fs.writeFileSync(path.join(directory, 'child.axl'), '#include "base.h"\nclass Child : Base { int y; };');
    const result = await initialize();
    assert.strictEqual(result.capabilities.typeHierarchyProvider, true);
    await open('main.axl', '#include "base.h"\nBase **value[2];');
    const base = (await prepare('main.axl', 1, 8))?.[0];
    assert.ok(base); assert.strictEqual(base.name, 'Base');
    assert.deepStrictEqual(await supers(base), []);
    const children = await subs(base);
    assert.deepStrictEqual(children?.map(item => item.name), ['Child']);
    assert.deepStrictEqual((await supers(children![0]))?.map(item => item.name), ['Base']);
    assert.strictEqual(children![0].selectionRange.start.line, 1);
  });

  test('applies the common scope while preserving excluded dependency type resolution', async () => {
    fs.writeFileSync(path.join(directory, 'base.h'), 'class Base { int x; };');
    fs.writeFileSync(path.join(directory, 'child.axl'), '#include "base.h"\nclass Child : Base { int y; };');
    await initialize({ project: { include: ['*.axl'], exclude: [] } });
    await open('main.axl', '#include "base.h"\nBase value;');
    const base = (await prepare('main.axl', 1, 6))![0];
    assert.strictEqual(base.name, 'Base');
    assert.deepStrictEqual((await subs(base))?.map(item => item.name), ['Child']);
    await server.configure({ settings: { project: { include: ['*.axl'], exclude: ['child.axl'] } } });
    assert.deepStrictEqual(await subs(base), []);
    await server.configure({ settings: { project: { include: [], exclude: [] } } });
    assert.deepStrictEqual(await subs(base), []);
    assert.strictEqual((await prepare('main.axl', 1, 6))?.[0].name, 'Base');
  });

  test('updates unsaved dependency edges and rejects deleted and forged items', async () => {
    const header = 'class Base { int x; };\nclass Other { int y; };';
    fs.writeFileSync(path.join(directory, 'base.h'), header);
    fs.writeFileSync(path.join(directory, 'child.axl'), '#include "base.h"\nclass Child : Base { int z; };');
    await initialize(); await open('base.h', header);
    const base = (await prepare('base.h', 0, 6))![0];
    assert.deepStrictEqual((await subs(base))?.map(item => item.name), ['Child']);
    await open('child.axl', '#include "base.h"\nclass Child : Other { int z; };');
    assert.deepStrictEqual(await subs(base), []);
    const child = (await prepare('child.axl', 1, 6))![0];
    assert.deepStrictEqual((await supers(child))?.map(item => item.name), ['Other']);
    await server.notify('textDocument/didChange', { textDocument: { uri: uri('child.axl'), version: 2 },
      contentChanges: [{ text: '#include "base.h"\n' }] });
    assert.strictEqual(await supers(child), null);
    assert.strictEqual(await subs({ ...base, data: { ...base.data, key: 'forged' } }), null);
    assert.strictEqual(await supers({ ...base, data: undefined }), null);
  });

  test('does not match same-named bases from separate files and responds to cancellation', async () => {
    fs.writeFileSync(path.join(directory, 'one.h'), 'class Base { int x; };');
    fs.writeFileSync(path.join(directory, 'two.h'), 'class Base { int x; };');
    fs.writeFileSync(path.join(directory, 'child.axl'), '#include "two.h"\nclass Child : Base { int z; };');
    await initialize(); await open('one.h', 'class Base { int x; };');
    const base = (await prepare('one.h', 0, 6))![0];
    assert.deepStrictEqual(await subs(base), []);
    const source = new CancellationTokenSource();
    const request = server.request('typeHierarchy/subtypes', { item: base }, source.token);
    source.cancel();
    await assert.rejects(request, (error: { code?: number }) => error.code === LSPErrorCodes.RequestCancelled);
    source.dispose();
    assert.deepStrictEqual(await subs(base), []);
  });
});
