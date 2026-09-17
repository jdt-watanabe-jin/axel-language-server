import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { createRequestHandler } from '../../util/cancellation';
suite('request queue cancellation', () => {
  test('a cancelled waiter responds before its predecessor and never executes', async () => {
    const wrap = createRequestHandler();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const handler = wrap(async (name: string) => {
      calls.push(name);
      if (name === 'first') { started(); await blocked; }
      return name;
    });
    const first = handler('first', CancellationToken.None);
    await entered;
    const source = new CancellationTokenSource();
    const second = handler('cancelled', source.token);
    source.cancel();
    await assert.rejects(second, (e: unknown) => (e as { code?: number }).code === LSPErrorCodes.RequestCancelled);
    release(); await first;
    assert.strictEqual(await handler('last', CancellationToken.None), 'last');
    assert.deepStrictEqual(calls, ['first', 'last']);
    source.dispose();
  });
});
