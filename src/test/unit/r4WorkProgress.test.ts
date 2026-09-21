import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { WorkProgress } from '../../lsp/workProgress';
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
suite('R4 work progress', () => {
  function fixture(supported = true, create?: () => Promise<unknown>) {
    const events: {token: string | number; value: {kind: string}}[] = [];
    let created = 0;
    const manager = new WorkProgress({
      supported: () => supported,
      create: async () => { created++; await create?.(); },
      send: (token, value) => { events.push({ token, value }); },
      error: message => assert.fail(message)
    }, 10);
    return { manager, events, created: () => created };
  }
  test('does not display fast work or unsupported progress', async () => {
    const f = fixture();
    assert.strictEqual(await f.manager.run('test', CancellationToken.None, async () => 42), 42);
    await delay(20); assert.strictEqual(f.created(), 0);
    const unsupported = fixture(false);
    await unsupported.manager.run('test', CancellationToken.None, () => delay(20));
    assert.strictEqual(unsupported.created(), 0);
  });
  test('creates one delayed display for joined work and cancellation of one waiter preserves the other', async () => {
    const f = fixture(); const first = new CancellationTokenSource();
    const a = f.manager.run('shared', first.token, async token => {
      await delay(35); assert.strictEqual(token.isCancellationRequested, true);
    }, { key: 'shared' });
    const b = f.manager.run('shared', CancellationToken.None, async token => {
      await delay(45); assert.strictEqual(token.isCancellationRequested, false); return 7;
    }, { key: 'shared' });
    first.cancel();
    await assert.rejects(a, (error: {code:number}) => error.code === LSPErrorCodes.RequestCancelled);
    assert.strictEqual(await b, 7); assert.strictEqual(f.created(), 1);
    assert.deepStrictEqual(f.events.map(e => e.value.kind), ['begin', 'end']);
    first.dispose();
  });
  test('progress cancel reaches every member of the displayed operation and ends once', async () => {
    const f = fixture();
    const pending = f.manager.run('long', CancellationToken.None, async token => {
      await delay(30); assert.ok(token.isCancellationRequested);
    });
    await delay(20); f.manager.cancel(f.events[0].token);
    await assert.rejects(pending, (error: {code:number}) => error.code === LSPErrorCodes.RequestCancelled);
    assert.deepStrictEqual(f.events.map(e => e.value.kind), ['begin', 'end']);
  });
  test('keeps numeric and string progress tokens distinct', async () => {
    const f = fixture();
    await Promise.all([
      f.manager.run('number', CancellationToken.None, () => delay(25), {workDoneToken: 0}),
      f.manager.run('string', CancellationToken.None, () => delay(25), {workDoneToken: '0'})
    ]);
    assert.deepStrictEqual(f.events.filter(e => e.value.kind === 'begin').map(e => e.token), [0, '0']);
  });
  test('uses supplied workDoneToken without creating a second display', async () => {
    const f = fixture();
    await f.manager.run('long', CancellationToken.None, () => delay(20), { workDoneToken: 0 });
    assert.strictEqual(f.created(), 0);
    assert.deepStrictEqual(f.events.map(e => e.token), [0, 0]);
  });
  test('does not start a late display when create resolves after work ends', async () => {
    let release!: () => void;
    const f = fixture(true, () => new Promise<void>(resolve => { release = resolve; }));
    await f.manager.run('long', CancellationToken.None, () => delay(20));
    release(); await delay(1);
    assert.ok(f.events.every(event => event.value.kind !== 'begin'));
  });
  test('ends failed work and cancels work on disposal', async () => {
    const f = fixture();
    await assert.rejects(f.manager.run('failed', CancellationToken.None, async () => { await delay(20); throw new Error('failure'); }), /failure/);
    const pending = f.manager.run('dispose', CancellationToken.None, async () => { await delay(20); });
    f.manager.dispose();
    await assert.rejects(pending, (error: {code:number}) => error.code === LSPErrorCodes.RequestCancelled);
    assert.deepStrictEqual(f.events.map(e => e.value.kind), ['begin', 'end']);
  });
});
