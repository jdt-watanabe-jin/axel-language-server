import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, LSPErrorCodes, ResponseError, type WorkspaceSymbolParams, type WorkspaceSymbol } from 'vscode-languageserver/node';
import { registerWorkspaceSymbolHandler } from '../../lsp/workspaceSymbols';
import { WorkProgress } from '../../lsp/workProgress';
import { toLspFoldingRanges } from '../../lsp/foldingRanges';
import type { HandlerRegistrationContext } from '../../lsp/registerHandlers';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Migrated LSP boundaries', () => {
  const { createTempDir } = useWorkspaceFixtures();
  test('workspace symbol supplied progress begins and ends when configuration wait is cancelled', async () => {
    let handler!: (params: WorkspaceSymbolParams, token: CancellationToken) => Promise<unknown>;
    let waiting!: () => void;
    let displayed!: () => void;
    const entered = new Promise<void>(resolve => { waiting = resolve; });
    const began = new Promise<void>(resolve => { displayed = resolve; });
    const events: { token: string | number; kind: string }[] = [];
    let created = 0;
    let observed: CancellationToken | undefined;
    const progress = new WorkProgress({
      supported: () => true,
      create: async () => { created++; },
      send: (token, value) => { events.push({ token, kind: value.kind }); if (value.kind === 'begin') { displayed(); } },
      error: assert.fail
    }, 0);
    const controller = registerWorkspaceSymbolHandler({
      progress,
      connection: {
        onWorkspaceSymbol: () => assert.fail('supplied tokens require the raw request registration'),
        onRequest: (method: string, value: typeof handler) => { assert.strictEqual(method, 'workspace/symbol'); handler = value; }
      },
      documents: { onDidChangeContent() {}, onDidClose() {} },
      configuration: { ready(token: CancellationToken) {
        observed = token; waiting();
        return new Promise<void>((_resolve, reject) => {
          const subscription = token.onCancellationRequested(() => {
            subscription.dispose(); reject(new ResponseError(LSPErrorCodes.RequestCancelled, 'cancelled configuration wait'));
          });
        });
      } },
      logger: { error: assert.fail }
    } as unknown as HandlerRegistrationContext)!;
    try {
      const pending = handler({ query: '', workDoneToken: 'supplied' }, CancellationToken.None);
      const rejected = assert.rejects(pending, { code: LSPErrorCodes.RequestCancelled });
      await entered;
      assert.deepStrictEqual(events, [], 'display starts asynchronously after work has entered');
      await began;
      progress.cancel('supplied');
      await rejected;
      assert.strictEqual(observed?.isCancellationRequested, true);
      assert.strictEqual(created, 0);
      assert.deepStrictEqual(events, [{ token: 'supplied', kind: 'begin' }, { token: 'supplied', kind: 'end' }]);
    } finally { progress.dispose(); await controller.dispose(); }
  });

  test('empty workspace folders clear initialized roots through the workspace symbol handler', async () => {
    const root = createTempDir();
    fs.writeFileSync(path.join(root, 'main.axl'), 'int removedRoot;');
    let search!: (params: WorkspaceSymbolParams, token: CancellationToken) => Promise<WorkspaceSymbol[]>;
    let requests = 0;
    const changed: string[][] = [];
    const controller = registerWorkspaceSymbolHandler({
      connection: {
        onWorkspaceSymbol: (handler: typeof search) => { search = handler; },
        sendRequest: async (type: { method: string }) => { assert.strictEqual(type.method, 'workspace/workspaceFolders'); requests++; return []; }
      },
      documents: { onDidChangeContent() {}, onDidClose() {} },
      configuration: { ready: async () => {} }, logger: { error: assert.fail }
    } as unknown as HandlerRegistrationContext, roots => changed.push(roots))!;
    try {
      controller.initialize({ processId: null, rootUri: pathToFileURL(root).toString(), capabilities: { workspace: { workspaceFolders: true } } });
      assert.deepStrictEqual((await search({ query: '' }, CancellationToken.None)).map(symbol => symbol.name), ['removedRoot']);
      await controller.resyncFolders(CancellationToken.None);
      assert.strictEqual(requests, 1);
      assert.deepStrictEqual(changed, [[]]);
      assert.deepStrictEqual(await search({ query: '' }, CancellationToken.None), []);
    } finally { await controller.dispose(); }
  });

  test('folding limits preserve the outer range, strip unsupported kinds and honor zero', () => {
    const ranges = [{ startLine: 0, endLine: 3, kind: 'region' as const }, { startLine: 1, endLine: 3, kind: 'comment' as const }];
    assert.deepStrictEqual(toLspFoldingRanges(ranges, { rangeLimit: 1, foldingRangeKind: { valueSet: [] } }), [{ startLine: 0, endLine: 3 }]);
    assert.deepStrictEqual(toLspFoldingRanges(ranges, { rangeLimit: 0 }), []);
  });
});
