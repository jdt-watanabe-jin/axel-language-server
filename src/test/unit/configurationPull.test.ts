import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { ConfigurationManager } from '../../lsp/configuration';

suite('configuration pull', () => {
  test('ignores unknown keys, property order and explicit defaults when comparing snapshots', async () => {
    let value: unknown = {};
    let applied = 0;
    const manager = new ConfigurationManager(() => Promise.resolve(value), () => { applied++; }, () => {}, () => {});
    manager.start(); await manager.ready(CancellationToken.None);
    value = { unknown: true, fileOperations: { exclude: [], updateIncludesOnRename: true },
      errorSquiggles: 'enabledIfIncludesResolve', tool: 'axel', includeRoots: [], inlayHints: { parameterNames: { enabled: false } } };
    manager.refresh(); await manager.ready(CancellationToken.None);
    assert.strictEqual(applied, 1);
    manager.dispose();
  });
  test('replaces snapshots, rejects invalid settings and recovers without a fallback', async () => {
    let value: unknown = { includeRoots: ['a'], forcedIncludeFiles: ['a.h'], errorSquiggles: 'disabled' };
    const applied: unknown[] = [];
    const errors: string[] = [];
    const manager = new ConfigurationManager(() => Promise.resolve(value), s => { applied.push(s); }, () => {}, e => errors.push(e));
    manager.start(); await manager.ready(CancellationToken.None);
    assert.strictEqual(manager.settings.errorSquiggles, 'disabled');
    value = {}; manager.refresh(); await manager.ready(CancellationToken.None);
    assert.deepStrictEqual(manager.settings, {});
    value = null; manager.refresh();
    await assert.rejects(manager.ready(CancellationToken.None), { code: LSPErrorCodes.RequestFailed });
    assert.strictEqual(manager.isReady, false);
    value = { includeRoots: 123 }; manager.refresh();
    await assert.rejects(manager.ready(CancellationToken.None), { code: LSPErrorCodes.RequestFailed });
    value = {}; manager.refresh(); await manager.ready(CancellationToken.None);
    assert.strictEqual(manager.isReady, true);
    assert.strictEqual(applied.length, 3, 'same settings must be reapplied after failure');
    assert.strictEqual(errors.length, 2);
    manager.dispose();
  });
  test('discards delayed responses and waits for the latest settings', async () => {
    const pending: ((value: unknown) => void)[] = [];
    const manager = new ConfigurationManager(() => new Promise(resolve => pending.push(resolve)), () => {}, () => {}, () => {});
    manager.start(); manager.refresh();
    const ready = manager.ready(CancellationToken.None);
    pending.shift()!({ defines: ['OLD'] });
    await new Promise(resolve => setImmediate(resolve));
    pending.shift()!({ defines: ['NEW'] });
    await ready;
    assert.deepStrictEqual(manager.settings.defines, ['NEW']);
    manager.dispose();
  });
  test('bounds failed acquisition and allows cancelling a waiter', async () => {
    const manager = new ConfigurationManager(() => new Promise(() => {}), () => {}, () => {}, () => {}, 20);
    manager.start();
    const source = new CancellationTokenSource();
    const waiting = manager.ready(source.token); source.cancel();
    await assert.rejects(waiting, { code: LSPErrorCodes.RequestCancelled });
    await assert.rejects(manager.ready(CancellationToken.None), { code: LSPErrorCodes.RequestFailed });
    assert.strictEqual(manager.isReady, false);
    source.dispose(); manager.dispose();
  });
});
