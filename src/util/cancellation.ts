import { CancellationToken, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';

export function throwIfCancelled(token: CancellationToken = CancellationToken.None): void {
  if (token.isCancellationRequested) { throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled.'); }
}

export function isCancellationError(error: unknown): boolean {
  return error instanceof ResponseError && (error.code === LSPErrorCodes.RequestCancelled
    || error.code === LSPErrorCodes.ContentModified || error.code === LSPErrorCodes.ServerCancelled);
}

export function rethrowCancellation(error: unknown): void {
  if (isCancellationError(error)) { throw error; }
}

/** A macrotask boundary is necessary to receive $/cancelRequest from the transport. */
export async function cancellationCheckpoint(token: CancellationToken): Promise<void> {
  throwIfCancelled(token);
  await new Promise<void>(resolve => setImmediate(resolve));
  throwIfCancelled(token);
}

/** Serialize requests sharing a mutable workspace; cancelled waiters settle immediately. */
export function createRequestHandler() {
  let tail: Promise<unknown> = Promise.resolve();
  return <P, T>(work: (params: P, token: CancellationToken) => T | Promise<T>) =>
    async (params: P, token: CancellationToken = CancellationToken.None): Promise<T> => {
      throwIfCancelled(token);
      const result = tail.then(async () => {
        await cancellationCheckpoint(token);
        const value = await work(params, token);
        throwIfCancelled(token);
        return value;
      });
      tail = result.catch(() => undefined);
      let subscription: { dispose(): void } | undefined;
      try {
        return await Promise.race([result, new Promise<never>((_resolve, reject) => {
          subscription = token.onCancellationRequested(() => {
            reject(new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled.'));
          });
        })]);
      } finally { subscription?.dispose(); }
    };
}
