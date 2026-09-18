import {
  CancellationToken,
  SymbolKind,
  type CallHierarchyIncomingCall,
  type CallHierarchyIncomingCallsParams,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type CallHierarchyOutgoingCallsParams,
  type CallHierarchyPrepareParams,
  type Range
} from 'vscode-languageserver/node';
import {
  incomingCallHierarchySteps,
  outgoingCallHierarchySteps,
  prepareCallHierarchySteps
} from '../analyzer/callHierarchy';
import type { AnalysisCallHierarchyCall, AnalysisCallHierarchyItem } from '../analyzer/callHierarchyModel';
import type { AnalyzeDocumentInput, AnalyzedDocument, AnalysisSymbolKind } from '../types/analysis';
import type { AnalysisStep } from '../util/analysisSteps';
import { rethrowCancellation, throwIfCancelled } from '../util/cancellation';
import type { HandlerRegistrationContext } from './registerHandlers';

type RequestHandler<P, T> = (params: P, token: CancellationToken) => Promise<T>;

export interface CallHierarchyRequestLifecycle {
  request<P, T>(work: RequestHandler<P, T>): (params: P, token?: CancellationToken) => Promise<T>;
  measureRequest<T>(
    token: CancellationToken,
    operation: string,
    details: Record<string, string | number | boolean | undefined>,
    work: () => T | Promise<T>
  ): Promise<T>;
  runRequestSteps<T>(steps: Generator<AnalysisStep, T, void>, token: CancellationToken): Promise<T>;
  analyzeRequest(token: CancellationToken, input: AnalyzeDocumentInput): Promise<AnalyzedDocument>;
}

export function registerCallHierarchyHandlers(
  context: HandlerRegistrationContext,
  lifecycle: CallHierarchyRequestLifecycle
): void {
  const callHierarchy = context.connection.languages.callHierarchy;
  if (callHierarchy === undefined) { return; }
  callHierarchy.onPrepare(lifecycle.request(async (params: CallHierarchyPrepareParams, token) => {
    const document = context.documents.get(params.textDocument.uri);
    return lifecycle.measureRequest(token, 'lsp.prepareCallHierarchy', {
      uri: params.textDocument.uri,
      version: document?.version,
      documentMissing: document === undefined ? true : undefined,
      line: params.position.line,
      character: params.position.character
    }, async () => {
      if (document === undefined) { return null; }
      try {
        const analysis = await lifecycle.analyzeRequest(token, {
          uri: document.uri,
          version: document.version,
          text: document.getText()
        });
        const items = await lifecycle.runRequestSteps(prepareCallHierarchySteps({
          analysis,
          position: params.position,
          workspaceIndex: context.analyzer
        }), token);
        return items?.map(toLspCallHierarchyItem) ?? null;
      } catch (error: unknown) {
        rethrowCancellation(error);
        throwIfCancelled(token);
        context.logger.error(`Prepare call hierarchy failed: ${errorMessage(error)}`);
        return null;
      }
    });
  }));

  callHierarchy.onIncomingCalls(lifecycle.request(async (
    params: CallHierarchyIncomingCallsParams,
    token
  ) => toLspIncomingCalls(await resolveCalls(context, lifecycle, params.item, token, 'incoming'))));

  callHierarchy.onOutgoingCalls(lifecycle.request(async (
    params: CallHierarchyOutgoingCallsParams,
    token
  ) => toLspOutgoingCalls(await resolveCalls(context, lifecycle, params.item, token, 'outgoing'))));
}

export function toLspCallHierarchyItem(item: AnalysisCallHierarchyItem): CallHierarchyItem {
  return {
    name: item.name,
    kind: toLspSymbolKind(item.kind),
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    uri: item.uri,
    range: item.range,
    selectionRange: item.selectionRange,
    data: item.data
  };
}

export function toLspIncomingCalls(calls: readonly AnalysisCallHierarchyCall[]): CallHierarchyIncomingCall[] {
  return calls.map(call => ({
    from: toLspCallHierarchyItem(call.item),
    fromRanges: call.fromRanges
  }));
}

export function toLspOutgoingCalls(calls: readonly AnalysisCallHierarchyCall[]): CallHierarchyOutgoingCall[] {
  return calls.map(call => ({
    to: toLspCallHierarchyItem(call.item),
    fromRanges: call.fromRanges
  }));
}

async function resolveCalls(
  context: HandlerRegistrationContext,
  lifecycle: CallHierarchyRequestLifecycle,
  lspItem: CallHierarchyItem,
  token: CancellationToken,
  direction: 'incoming' | 'outgoing'
): Promise<AnalysisCallHierarchyCall[]> {
  const item = fromLspCallHierarchyItem(lspItem);
  return lifecycle.measureRequest(token, `lsp.${direction}Calls`, {
    uri: item?.data.sourceUri,
    itemUri: item?.uri,
    itemName: item?.name,
    invalidItem: item === undefined ? true : undefined
  }, async () => {
    if (item === undefined) { return []; }
    try {
      const analysis = await analysisForSource(context, lifecycle, item.data.sourceUri, token);
      if (analysis === undefined) { return []; }
      const steps = direction === 'incoming'
        ? incomingCallHierarchySteps({ item, analysis, workspaceIndex: context.analyzer })
        : outgoingCallHierarchySteps({ item, analysis, workspaceIndex: context.analyzer });
      return lifecycle.runRequestSteps(steps, token);
    } catch (error: unknown) {
      rethrowCancellation(error);
      throwIfCancelled(token);
      context.logger.error(`${direction === 'incoming' ? 'Incoming' : 'Outgoing'} call hierarchy failed: ${errorMessage(error)}`);
      return [];
    }
  });
}

async function analysisForSource(
  context: HandlerRegistrationContext,
  lifecycle: CallHierarchyRequestLifecycle,
  sourceUri: string,
  token: CancellationToken
): Promise<AnalyzedDocument | undefined> {
  const document = context.documents.get(sourceUri);
  if (document !== undefined) {
    return lifecycle.analyzeRequest(token, {
      uri: document.uri,
      version: document.version,
      text: document.getText()
    });
  }
  return context.analyzer.getAnalyzedDocument?.(sourceUri);
}

function fromLspCallHierarchyItem(item: CallHierarchyItem): AnalysisCallHierarchyItem | undefined {
  const kind = fromLspSymbolKind(item?.kind);
  const data = callHierarchyData(item?.data);
  if (kind === undefined || data === undefined || typeof item.name !== 'string' || item.name.length === 0
    || typeof item.uri !== 'string' || item.uri.length === 0 || !isRange(item.range) || !isRange(item.selectionRange)
    || (item.detail !== undefined && typeof item.detail !== 'string')) {
    return undefined;
  }
  return {
    name: item.name,
    kind,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    uri: item.uri,
    range: item.range,
    selectionRange: item.selectionRange,
    data
  };
}

function callHierarchyData(value: unknown): AnalysisCallHierarchyItem['data'] | undefined {
  if (value === null || typeof value !== 'object') { return undefined; }
  const data = value as Record<string, unknown>;
  return typeof data.key === 'string' && data.key.length > 0
    && typeof data.sourceUri === 'string' && data.sourceUri.length > 0
    ? { key: data.key, sourceUri: data.sourceUri }
    : undefined;
}

function isRange(value: unknown): value is Range {
  if (value === null || typeof value !== 'object') { return false; }
  const range = value as { start?: unknown; end?: unknown };
  return isPosition(range.start) && isPosition(range.end);
}

function isPosition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') { return false; }
  const position = value as { line?: unknown; character?: unknown };
  return Number.isInteger(position.line) && (position.line as number) >= 0
    && Number.isInteger(position.character) && (position.character as number) >= 0;
}

function toLspSymbolKind(kind: AnalysisSymbolKind | 'file'): SymbolKind {
  switch (kind) {
    case 'constructor': return SymbolKind.Constructor;
    case 'operator': return SymbolKind.Operator;
    case 'function': return SymbolKind.Function;
    case 'method': return SymbolKind.Method;
    case 'parameter':
    case 'variable': return SymbolKind.Variable;
    case 'field': return SymbolKind.Field;
    case 'typedef': return SymbolKind.TypeParameter;
    case 'class': return SymbolKind.Class;
    case 'struct': return SymbolKind.Struct;
    case 'union': return SymbolKind.Object;
    case 'enum': return SymbolKind.Enum;
    case 'enumMember': return SymbolKind.EnumMember;
    case 'macro': return SymbolKind.Constant;
    case 'include':
    case 'file': return SymbolKind.File;
  }
}

function fromLspSymbolKind(kind: SymbolKind): AnalysisSymbolKind | 'file' | undefined {
  switch (kind) {
    case SymbolKind.Constructor: return 'constructor';
    case SymbolKind.Operator: return 'operator';
    case SymbolKind.Function: return 'function';
    case SymbolKind.Method: return 'method';
    case SymbolKind.Variable: return 'variable';
    case SymbolKind.Field: return 'field';
    case SymbolKind.TypeParameter: return 'typedef';
    case SymbolKind.Class: return 'class';
    case SymbolKind.Struct: return 'struct';
    case SymbolKind.Object: return 'union';
    case SymbolKind.Enum: return 'enum';
    case SymbolKind.EnumMember: return 'enumMember';
    case SymbolKind.Constant: return 'macro';
    case SymbolKind.File: return 'file';
    default: return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
