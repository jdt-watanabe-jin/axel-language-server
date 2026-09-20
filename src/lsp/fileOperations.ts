import { CancellationTokenSource, type InitializeParams, type WorkspaceEdit } from 'vscode-languageserver/node';
import type { HandlerRegistrationContext } from './registerHandlers';
import { throwIfCancelled } from '../util/cancellation';
import { FileRenameIndex } from '../analyzer/fileOperations';
import { performance } from 'perf_hooks';

export function registerFileOperations(context: HandlerRegistrationContext, invalidate: (uris: string[]) => void) {
  let roots: string[] = [];
  let editsSupported = false;
  const index = new FileRenameIndex(() => context.documents.all?.() ?? [], message => context.logger.info?.(message), context.projectScope);
  let warming: CancellationTokenSource | undefined;
  let timer: NodeJS.Timeout | undefined;
  let dirty = true;
  const schedule = () => {
    dirty = true;
    clearTimeout(timer);
    warming?.cancel();
    if (!context.configuration?.isReady) { return; }
    timer = setTimeout(() => {
      const source = new CancellationTokenSource(); warming = source;
      void index.warm(source.token).finally(() => {
        if (warming === source) { dirty = source.token.isCancellationRequested; warming = undefined; }
        source.dispose();
      });
    }, 50);
  };
  const changed = (uris: readonly string[]) => { index.invalidate(uris); schedule(); };
  context.documents.onDidChangeContent(event => changed([event.document.uri]));
  context.documents.onDidClose(event => changed([event.document.uri]));
  const workspace = context.connection.workspace;
  workspace?.onWillCreateFiles?.((_params, token) => { throwIfCancelled(token); return null; });
  workspace?.onWillDeleteFiles?.((_params, token) => { throwIfCancelled(token); return null; });
  workspace?.onDidCreateFiles?.(params => invalidate(params.files.map(file => file.uri)));
  workspace?.onDidDeleteFiles?.(params => invalidate(params.files.map(file => file.uri)));
  workspace?.onDidRenameFiles?.(params => invalidate(params.files.flatMap(file => [file.oldUri, file.newUri])));
  workspace?.onWillRenameFiles?.(async (params, token): Promise<WorkspaceEdit | null> => {
    if (!editsSupported) { return null; }
    throwIfCancelled(token);
    const source = new CancellationTokenSource();
    const subscription = token.onCancellationRequested(() => source.cancel());
    const started = performance.now();
    let expired = false;
    const timeout = setTimeout(() => { expired = true; source.cancel(); }, 1500);
    try {
      await context.configuration!.ready(source.token);
      return await index.getEdits(params.files, source.token, Math.max(0, 1500 - (performance.now() - started)));
    } catch (error) {
      throwIfCancelled(token);
      if (expired) { context.logger.info?.('Include rename exceeded its time budget.'); return null; }
      throw error;
    } finally { clearTimeout(timeout); subscription.dispose(); source.dispose(); }
  });
  return {
    initialize(params: InitializeParams) {
      roots = params.workspaceFolders?.map(folder => folder.uri) ?? (params.rootUri ? [params.rootUri] : []);
      editsSupported = params.capabilities.workspace?.workspaceEdit?.documentChanges === true;
      index.configure(roots, {});
    },
    setRoots(next: string[]) { roots = next; index.configure(roots, context.configuration?.settings ?? {}); schedule(); },
    configure() { index.configure(roots, context.configuration!.settings); schedule(); },
    resume() { if (dirty) { schedule(); } },
    invalidate: changed,
    pause() { clearTimeout(timer); warming?.cancel(); index.invalidate(); },
    dispose() { clearTimeout(timer); warming?.cancel(); }
  };
}
