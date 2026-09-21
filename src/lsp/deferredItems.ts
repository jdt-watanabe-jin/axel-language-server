import { randomUUID } from 'crypto';
import { ErrorCodes, LSPErrorCodes, ResponseError, type CancellationToken, type CompletionItem, type InlayHint } from 'vscode-languageserver/node';
import { completionDocumentation, getCompletions, type CompletionInput } from '../analyzer/completion';
import type { AnalysisInlayHint } from '../analyzer/inlayHints';
import { boundDocumentationFor } from '../analyzer/documentation/access';
import { renderParameterDocumentation } from '../analyzer/documentation/render';
import { contains } from '../analyzer/resolution';
import type { AnalyzedDocument } from '../types/analysis';
import { cancellationCheckpoint } from '../util/cancellation';
import { toLspCompletionItemForClient } from './completion';
import { normalizeInlayHintsSettings, toLspInlayHints } from './inlayHints';
import type { HandlerRegistrationContext } from './registerHandlers';

interface Lifecycle {
  request<P, T>(work: (params: P, token: CancellationToken) => Promise<T>): (params: P, token?: CancellationToken) => Promise<T>;
}
interface DeferredBatch<T> {
  revision: number;
  uri: string;
  version: number;
  items: { original: T; resolve: () => T }[];
}

/** Bound snapshots, not client-provided symbol names, determine deferred item identity. */
class ItemStore<T extends { data?: unknown }> {
  private readonly session = randomUUID();
  private next = 0;
  private readonly batches = new Map<number, DeferredBatch<T>>();
  constructor(private readonly context: HandlerRegistrationContext, private readonly revision: () => number) {}
  clear(): void { this.batches.clear(); }
  issue(uri: string, version: number, items: DeferredBatch<T>['items']): T[] {
    for (const [id, batch] of this.batches) { if (batch.revision !== this.revision()) { this.batches.delete(id); } }
    const id = ++this.next;
    this.batches.set(id, { uri, version, revision: this.revision(), items });
    while (this.batches.size > 8) { this.batches.delete(this.batches.keys().next().value!); }
    return items.map((item, index) => ({ ...item.original, data: { session: this.session, id, index } }));
  }
  resolve(data: unknown): T {
    if (!data || typeof data !== 'object') { throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid resolve data.'); }
    const value = data as { session: unknown; id: number; index: number };
    if (value.session !== this.session || !Number.isInteger(value.id) || !Number.isInteger(value.index) || value.index < 0) {
      throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid resolve identity.');
    }
    const batch = this.batches.get(value.id);
    if (!batch || batch.revision !== this.revision() || this.context.documents.get(batch.uri)?.version !== batch.version) {
      if (batch) { this.batches.delete(value.id); }
      throw new ResponseError(LSPErrorCodes.ContentModified, 'Resolve source or dependencies changed.');
    }
    const item = batch.items[value.index];
    if (!item) { throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid resolve index.'); }
    return { ...item.resolve(), data };
  }
}

export function registerDeferredItemHandlers(context: HandlerRegistrationContext, lifecycle: Lifecycle, revision: () => number) {
  const completion = new ItemStore<CompletionItem>(context, revision);
  const inlay = new ItemStore<InlayHint>(context, revision);
  const completionProperties = () => context.clientCapabilities?.textDocument?.completion?.completionItem?.resolveSupport?.properties ?? [];
  const inlayProperties = () => context.clientCapabilities?.textDocument?.inlayHint?.resolveSupport?.properties ?? [];
  context.connection.onCompletionResolve?.(lifecycle.request(async (item: CompletionItem, token) => {
    const started = Date.now();
    await cancellationCheckpoint(token);
    const result = completion.resolve(item?.data);
    context.logger.info?.(`[timing] operation=lsp.completionResolve durationMs=${Date.now() - started}`);
    return result;
  }));
  context.connection.languages.inlayHint?.resolve?.(lifecycle.request(async (item: InlayHint, token) => {
    await cancellationCheckpoint(token);
    if (!normalizeInlayHintsSettings(context.configuration?.settings).enabled) {
      throw new ResponseError(LSPErrorCodes.ContentModified, 'Inlay hints disabled.');
    }
    const started = Date.now();
    const result = inlay.resolve(item?.data);
    context.logger.info?.(`[timing] operation=lsp.inlayHintResolve durationMs=${Date.now() - started}`);
    return result;
  }));
  return {
    clear() { completion.clear(); inlay.clear(); },
    inlayResolveEnabled() { return inlayProperties().some(property => ['tooltip', 'label.tooltip', 'label.location'].includes(property)); },
    completions(input: CompletionInput, markdown: boolean): CompletionItem[] {
      const properties = completionProperties();
      const docs = properties.includes('documentation');
      const detail = properties.includes('detail');
      const items = getCompletions({ ...input, deferDocumentation: docs });
      if (!docs && !detail) { return items.map(item => toLspCompletionItemForClient(item, markdown)); }
      return completion.issue(input.analysis.uri, input.analysis.version, items.map(item => {
        const full = toLspCompletionItemForClient(item, markdown);
        const original = { ...full };
        if (docs) { delete original.documentation; }
        if (detail) { delete original.detail; }
        return { original, resolve: () => {
          const resolved = { ...full };
          if (docs && item.documentationTarget) {
            const documentation = completionDocumentation({ ...input, deferDocumentation: false }, item.documentationTarget);
            resolved.documentation = toLspCompletionItemForClient({ ...item, ...documentation }, markdown).documentation;
          }
          return resolved;
        } };
      }));
    },
    inlayHints(hints: AnalysisInlayHint[], analysis: AnalyzedDocument, locale?: string): InlayHint[] {
      const properties = inlayProperties();
      const simple = toLspInlayHints(hints);
      if (!this.inlayResolveEnabled()) { return simple; }
      if (properties.includes('label.tooltip') || properties.includes('label.location')) {
        hints.forEach((hint, index) => { if (hint.resolveTarget) { simple[index].label = [{ value: hint.label }]; } });
      }
      const issued = inlay.issue(analysis.uri, analysis.version, hints.map((hint, index) => ({
        original: simple[index],
        resolve: () => {
          const result = { ...simple[index] };
          const target = hint.resolveTarget;
          if (!target) { return result; }
          const declaration = target.declaration;
          const parameter = declaration.signature?.parameters[target.parameter];
          const bound = boundDocumentationFor(analysis, context.analyzer, declaration);
          const description = bound && renderParameterDocumentation(bound, target.parameter, locale);
          const tooltip = [parameter?.label, description?.plainText ?? parameter?.documentation].filter(Boolean).join('\n\n');
          if (properties.includes('tooltip') && tooltip) { result.tooltip = tooltip; }
          if (properties.includes('label.tooltip') || properties.includes('label.location')) {
            const part: { value: string; tooltip?: string; location?: { uri: string; range: typeof declaration.selectionRange } } = { value: hint.label };
            if (properties.includes('label.tooltip') && tooltip) { part.tooltip = tooltip; }
            if (properties.includes('label.location')) {
              const owner = declaration.uri === analysis.uri ? analysis : context.analyzer.getAnalyzedDocument?.(declaration.uri);
              const parameterDeclaration = owner?.declarations.find(candidate => candidate.kind === 'parameter'
                && candidate.name === parameter?.name && contains(declaration.range, candidate.selectionRange.start));
              part.location = { uri: declaration.uri, range: parameterDeclaration?.selectionRange ?? declaration.selectionRange };
            }
            result.label = [part];
          }
          return result;
        }
      })));
      return issued.map((item, index) => hints[index].resolveTarget ? item : simple[index]);
    }
  };
}
