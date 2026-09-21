import { randomUUID } from 'crypto';
import { CancellationToken, CancellationTokenSource, type ProgressToken, type WorkDoneProgressBegin,
  type WorkDoneProgressReport, type WorkDoneProgressEnd } from 'vscode-languageserver/node';
import { AsyncLocalStorage } from 'async_hooks';
import { throwIfCancelled } from '../util/cancellation';
import type { HandlerRegistrationContext } from './registerHandlers';

type Value = WorkDoneProgressBegin | WorkDoneProgressReport | WorkDoneProgressEnd;
interface Transport {
  supported(): boolean;
  create(token: ProgressToken): Promise<unknown>;
  send(token: ProgressToken, value: Value): unknown;
  error(message: string): void;
}
interface Group {
  token: ProgressToken; title: string; members: Set<CancellationTokenSource>;
  timer?: ReturnType<typeof setTimeout>; ended: boolean; visible: boolean; creating: boolean;
  message?: string; percentage?: number;
}
interface Options { key?: string; workDoneToken?: ProgressToken }

/** One display represents one explicitly cancellable operation, possibly with several consumers. */
export class WorkProgress {
  private readonly groups = new Map<string, Group>();
  private readonly tokens = new Map<ProgressToken, Group>();
  private readonly current = new AsyncLocalStorage<Group>();
  private disposed = false;
  constructor(private readonly transport: Transport, private readonly delayMs = 1000) {}
  cancel(token: ProgressToken): void {
    for (const source of this.tokens.get(token)?.members ?? []) { source.cancel(); }
  }
  report(message: string, percentage?: number): void {
    const group = this.current.getStore();
    if (!group || group.ended) { return; }
    group.message = message;
    group.percentage = percentage === undefined ? undefined : Math.max(0, Math.min(100, Math.floor(percentage)));
    if (group.visible) { this.send(group, { kind: 'report', message, percentage: group.percentage }); }
  }
  async run<T>(title: string, parent: CancellationToken, work: (token: CancellationToken) => Promise<T>, options: Options = {}): Promise<T> {
    throwIfCancelled(parent);
    const source = new CancellationTokenSource();
    const subscription = parent.onCancellationRequested(() => source.cancel());
    if (this.disposed || parent.isCancellationRequested) { source.cancel(); }
    const supplied = options.workDoneToken !== undefined;
    const key = supplied ? 'token:' + typeof options.workDoneToken + ':' + options.workDoneToken : options.key ?? randomUUID();
    let group = this.groups.get(key);
    if (!group) {
      group = { token: options.workDoneToken ?? randomUUID(), title, members: new Set(), ended: false, visible: false, creating: false };
      this.groups.set(key, group); this.tokens.set(group.token, group);
      if (!this.disposed && this.transport.supported()) {
        const target = group;
        group.timer = setTimeout(() => { void this.show(target, supplied); }, this.delayMs);
      }
    }
    group.members.add(source);
    try {
      throwIfCancelled(source.token);
      const result = await this.current.run(group, () => work(source.token));
      throwIfCancelled(source.token);
      return result;
    } finally {
      subscription.dispose(); source.dispose(); group.members.delete(source);
      if (!group.members.size) {
        this.finish(group); this.groups.delete(key); this.tokens.delete(group.token);
      }
    }
  }
  private async show(group: Group, supplied: boolean): Promise<void> {
    if (group.ended || this.disposed || [...group.members].every(member => member.token.isCancellationRequested)) { return; }
    group.creating = true;
    try {
      if (!supplied) { await this.transport.create(group.token); }
      group.creating = false;
      if (group.ended || this.disposed) {
        // Close the client allocation without flashing a completed operation.
        if (!supplied) { this.send(group, { kind: 'end' }); }
        return;
      }
      group.visible = true;
      this.send(group, { kind: 'begin', title: group.title, cancellable: true,
        message: group.message, percentage: group.percentage });
    } catch (error) {
      group.creating = false;
      this.transport.error('AXEL progress unavailable: ' + String(error));
    }
  }
  private send(group: Group, value: Value): void {
    try { void Promise.resolve(this.transport.send(group.token, value)).catch(error => this.transport.error(String(error))); }
    catch (error) { this.transport.error(String(error)); }
  }
  private finish(group: Group): void {
    if (group.ended) { return; }
    group.ended = true; clearTimeout(group.timer);
    if (group.visible) { this.send(group, { kind: 'end' }); group.visible = false; }
  }
  dispose(): void {
    this.disposed = true;
    for (const group of this.groups.values()) {
      for (const source of group.members) { source.cancel(); }
      this.finish(group);
    }
    this.groups.clear(); this.tokens.clear();
  }
}

/** Register raw LSP requests so the original workDoneToken survives library attachment. */
export function progressRequest<P, T>(context: HandlerRegistrationContext, method: string, title: string,
  fallback: (handler: (params: P, token: CancellationToken) => Promise<T>) => unknown,
  handler: (params: P, token: CancellationToken) => Promise<T>, key?: string): void {
  if (!context.progress || !context.connection.onRequest) { fallback(handler); return; }
  context.connection.onRequest(method, (params: P & { workDoneToken?: ProgressToken }, token: CancellationToken) =>
    context.progress!.run(title, token, cancellation => handler(params, cancellation), {
      key: key ?? (['textDocument/diagnostic', 'textDocument/semanticTokens/full'].includes(method) ? 'analysis' : undefined), workDoneToken: params?.workDoneToken
    }));
}
