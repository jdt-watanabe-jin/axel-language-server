import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Diagnostic, DocumentDiagnosticReport, Hover } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP error squiggles', function () {
  this.timeout(20_000);
  let directory: string;
  let server: ReturnType<typeof startLspServer>;
  const uri = (name: string) => pathToFileURL(path.join(directory, name)).toString();
  setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-squiggles-')); server = startLspServer(); });
  teardown(async () => {
    await server.stop();
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function initialize(settings: object = {}) {
    await server.request('initialize', { processId: null, rootUri: null, capabilities: {}, initializationOptions: settings });
    await server.notify('initialized', {});
  }
  async function open(name: string, text: string) {
    await server.notify('textDocument/didOpen', { textDocument: { uri: uri(name), languageId: 'axel', version: 1, text } });
  }
  async function diagnostics(name = 'main.axl'): Promise<Diagnostic[]> {
    const result = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri: uri(name) } });
    assert.ok(result.kind === 'full');
    return result.items;
  }
  async function eventually(check: (items: Diagnostic[]) => boolean, name = 'main.axl') {
    const deadline = Date.now() + 3000;
    let items: Diagnostic[];
    do {
      items = await diagnostics(name);
      if (check(items)) { return items; }
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.fail(JSON.stringify(items));
  }
  const hasUnknown = (items: Diagnostic[]) => items.some(item => item.message.includes('unknownValue'));

  test('disabled clears errors and warnings, preserves hover, and re-enables without edits', async () => {
    await initialize({ errorSquiggles: 'disabled' });
    await open('main.axl', '#define __LINE__ 9\nint knownValue;\nvoid main() { unknownValue; }');
    assert.deepStrictEqual(await diagnostics(), []);
    assert.ok(await server.request<Hover>('textDocument/hover', { textDocument: { uri: uri('main.axl') }, position: { line: 1, character: 6 } }));
    await server.notify('workspace/didChangeConfiguration', { settings: { errorSquiggles: 'enabled' } });
    const items = await eventually(hasUnknown);
    assert.ok(items.some(item => item.severity === 2));
    await server.notify('workspace/didChangeConfiguration', { settings: { errorSquiggles: 'disabled' } });
    assert.deepStrictEqual(await diagnostics(), []);
  });

  test('default keeps missing-include errors only; enabled and invalid settings select the documented modes', async () => {
    await initialize();
    await open('main.axl', '#include "missing.h"\nvoid main() { unknownValue; }');
    const items = await diagnostics();
    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.ok(items[0].message.includes('missing.h'));
    await open('other.axl', 'void main() { unknownValue; }');
    assert.ok(hasUnknown(await diagnostics('other.axl')), 'one file must not disable diagnostics in another');
    await server.notify('workspace/didChangeConfiguration', { settings: { errorSquiggles: 'enabled' } });
    assert.ok(hasUnknown(await diagnostics()));
    await server.notify('workspace/didChangeConfiguration', { settings: { errorSquiggles: 'invalid' } });
    assert.strictEqual((await diagnostics()).length, 1);
  });

  test('limits unresolved include diagnostics after applying the presentation policy', async () => {
    await initialize({ maxNumberOfProblems: 1 });
    await open('main.axl', '#include "one.h"\n#include "two.h"\nvoid main() { unknownValue; }');
    const items = await diagnostics();
    assert.strictEqual(items.length, 1, JSON.stringify(items));
    assert.ok(items[0].message.includes('one.h'));
  });

  test('nested includes suppress dependent errors and recover after file creation and deletion', async () => {
    fs.writeFileSync(path.join(directory, 'outer.h'), '#include "inner.h"\nint headerValue;');
    await initialize({ errorSquiggles: 'enabledIfIncludesResolve' });
    await open('main.axl', '#include "outer.h"\nvoid main() { unknownValue; }');
    const missing = await eventually(items => items.some(item => item.message.includes('inner.h')));
    assert.ok(!hasUnknown(missing));
    assert.strictEqual(missing[0].range.start.line, 0);
    fs.writeFileSync(path.join(directory, 'inner.h'), 'int innerValue;');
    await server.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('inner.h'), type: 1 }] });
    await eventually(hasUnknown);
    fs.unlinkSync(path.join(directory, 'inner.h'));
    await server.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri('inner.h'), type: 3 }] });
    const removed = await eventually(items => items.some(item => item.message.includes('inner.h')));
    assert.ok(!hasUnknown(removed));
  });

  test('closing an included header does not leave diagnostics waiting forever', async () => {
    fs.writeFileSync(path.join(directory, 'types.h'), 'int knownValue;');
    await initialize();
    await open('main.axl', '#include "types.h"\nvoid main() { unknownValue; }');
    await eventually(hasUnknown);
    await open('types.h', 'int knownValue;');
    await eventually(hasUnknown);
    await server.notify('textDocument/didClose', { textDocument: { uri: uri('types.h') } });
    await eventually(hasUnknown);
  });

  test('inactive includes do not suppress errors and include cycles terminate', async () => {
    fs.writeFileSync(path.join(directory, 'a.h'), '#include "b.h"');
    fs.writeFileSync(path.join(directory, 'b.h'), '#include "a.h"');
    await initialize();
    await open('main.axl', '#if 0\n#include "missing.h"\n#endif\n#include "a.h"\nvoid main() { unknownValue; }');
    await eventually(hasUnknown);
  });

  test('missing forced includes suppress other diagnostics and includeRoots changes restore diagnostics', async () => {
    const forced = path.join(directory, 'forced.h');
    await initialize({ forcedIncludeFiles: [forced] });
    await open('main.axl', 'void main() { unknownValue; }');
    const missing = await diagnostics();
    assert.ok(missing.some(item => item.message.includes('forced.h')), JSON.stringify(missing));
    assert.ok(!hasUnknown(missing));
    fs.mkdirSync(path.join(directory, 'includes'));
    fs.writeFileSync(forced, '#include <types.h>');
    fs.writeFileSync(path.join(directory, 'includes', 'types.h'), 'int includedValue;');
    await server.notify('workspace/didChangeConfiguration', { settings: { forcedIncludeFiles: [forced], includeRoots: [path.join(directory, 'includes')] } });
    await eventually(hasUnknown);
  });
});
