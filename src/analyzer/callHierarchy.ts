import type { AnalysisStep } from '../util/analysisSteps';
import { findNavigationTargetDeclaration, type NavigationInput, type WorkspaceNavigationIndex } from './navigation';
import type { AnalysisDeclaration, AnalysisPosition, AnalysisRange, AnalyzedDocument } from '../types/analysis';
import type { AnalysisCallHierarchyCall, AnalysisCallHierarchyItem } from './callHierarchyModel';
import { collectHierarchySymbols, excluded, ownerAt, rangeKey, type HierarchySymbol } from './callHierarchySymbols';
import { collectSemanticCallData, type SemanticCallData } from './callHierarchySemantics';
import type { TypeDiagnosticsInput } from './typeChecking/diagnostics';
import { comparePositions } from './resolution';
import { containsSourcePosition } from './systemMacros';

interface HierarchyWorkspace extends WorkspaceNavigationIndex {
  callHierarchyTypeInput?(analysis: AnalyzedDocument): TypeDiagnosticsInput;
}

interface Edge { from: string; to: string; uri: string; range: AnalysisRange; kind: 'call' | 'reference' }
interface Graph {
  documents: AnalyzedDocument[];
  symbols: Map<string, HierarchySymbol>;
  aliases: Map<string, string>;
  byDocument: Map<string, HierarchySymbol[]>;
  calls: Map<string, SemanticCallData['calls']>;
  references: Map<string, SemanticCallData['references']>;
  incoming: Map<string, Edge[]>;
  outgoing: Map<string, Edge[]>;
  bases: Map<string, Set<string>>;
  contextualAliases: Map<string, Map<string, string>>;
}
interface DocumentData { dependencies: AnalyzedDocument[]; catalog: unknown; semantic?: SemanticCallData; symbols: HierarchySymbol[] }
interface WorkspaceCache { graphs: Map<string, Graph>; documents: WeakMap<AnalyzedDocument, DocumentData> }
type GraphQuery = {direction:'prepare';position:AnalysisPosition} | {direction:'incoming'|'outgoing';item:AnalysisCallHierarchyItem};
const caches = new WeakMap<WorkspaceNavigationIndex, WorkspaceCache>();

function uniqueDocuments(documents: AnalyzedDocument[]): AnalyzedDocument[] {
  return [...new Map(documents.map(document => [document.uri, document])).values()];
}
function sameDocuments(a: AnalyzedDocument[], b: AnalyzedDocument[]): boolean {
  return a.length === b.length && a.every((document, i) => document === b[i]);
}
function addEdge(graph: Graph, edge: Edge): void {
  const incoming = graph.incoming.get(edge.to) ?? [];
  incoming.push(edge); graph.incoming.set(edge.to, incoming);
  const outgoing = graph.outgoing.get(edge.from) ?? [];
  outgoing.push(edge); graph.outgoing.set(edge.from, outgoing);
}

function valueTarget(input: NavigationInput, graph: Graph): AnalysisDeclaration | undefined {
  const target = findNavigationTargetDeclaration(input);
  if (!target?.signature || !['function','method'].includes(target.kind)) { return undefined; }
  const visible = [input.analysis, ...input.workspaceIndex.listVisibleDocuments?.(input.analysis.uri) ?? []];
  const keys = new Set(visible.flatMap(document => document.declarations)
    .filter(declaration => declaration.signature && declaration.name === target.name
      && declaration.containerName === target.containerName)
    .flatMap(declaration => graph.aliases.get(declaration.id) ?? []));
  return keys.size <= 1 ? target : undefined;
}

function* graphSteps(analysis: AnalyzedDocument, workspaceIndex: HierarchyWorkspace, query: GraphQuery): Generator<AnalysisStep, Graph, void> {
  yield;
  const documents = uniqueDocuments([...(workspaceIndex.listReferenceSearchDocuments?.(analysis.uri)
    ?? workspaceIndex.listVisibleDocuments?.(analysis.uri) ?? []), analysis]);
  let cache = caches.get(workspaceIndex);
  if (!cache) { cache = {graphs:new Map(),documents:new WeakMap()}; caches.set(workspaceIndex,cache); }
  const cacheKey = JSON.stringify([analysis.uri,query.direction,query.direction === 'prepare' ? query.position : query.item.data.key]);
  const cached = cache.graphs.get(cacheKey);
  if (cached && sameDocuments(cached.documents, documents)) { return cached; }
  const graph: Graph = {documents,symbols:new Map(),aliases:new Map(),byDocument:new Map(),calls:new Map(),references:new Map(),
    incoming:new Map(),outgoing:new Map(),bases:new Map(),contextualAliases:new Map()};
  const data = new Map<string, DocumentData>();
  const inputs = new Map<string,TypeDiagnosticsInput>();
  const visibility = new Map<string, Set<string>>();
  for (const document of documents) {
    yield;
    const input = workspaceIndex.callHierarchyTypeInput?.(document) ?? {analysis:document,
      documents:workspaceIndex.listVisibleDocuments?.(document.uri) ?? []};
    inputs.set(document.uri,input);
    const dependencies = uniqueDocuments([document, ...input.documents ?? [], ...input.loginScope?.documents ?? []]);
    visibility.set(document.uri, new Set(dependencies.map(d => d.uri)));
    let item = cache.documents.get(document);
    if (!item || !sameDocuments(item.dependencies, dependencies) || item.catalog !== input.catalog) {
      const symbols = yield* collectHierarchySymbols(document, analysis.uri);
      item = {dependencies,catalog:input.catalog,symbols};
      cache.documents.set(document, item);
    }
    data.set(document.uri,item);
    graph.byDocument.set(document.uri,item.symbols);
  }
  // Link declarations only through actual visibility, never merely by a workspace-wide name match.
  const groups = new Map<string, HierarchySymbol[]>();
  for (const item of data.values()) {
    for (const symbol of item.symbols) {
      const group = groups.get(symbol.signature) ?? [];
      group.push(symbol); groups.set(symbol.signature,group);
    }
  }
  const canonical = new Map<HierarchySymbol, string>();
  for (const group of groups.values()) {
    yield;
    const pending = new Set([...group].sort((a,b) => Number(b.definition)-Number(a.definition)
      || Number(b.item.uri === analysis.uri)-Number(a.item.uri === analysis.uri)));
    while (pending.size) {
      const first = pending.values().next().value!;
      pending.delete(first);
      const component = [first];
      for (const current of component) {
        for (const next of pending) {
          const sameFile = current.item.uri === next.item.uri;
          const callable = current.crossFile && next.crossFile;
          if (next.definition && component.some(symbol => symbol.definition && symbol.item.uri !== next.item.uri)) { continue; }
          if (current.item.data.key === next.item.data.key || (!sameFile && callable &&
            (visibility.get(current.item.uri)?.has(next.item.uri) || visibility.get(next.item.uri)?.has(current.item.uri)))) {
            component.push(next); pending.delete(next);
          }
        }
      }
      const preferred = [...component].sort((a,b) => Number(b.definition)-Number(a.definition)
        || a.item.uri.localeCompare(b.item.uri) || comparePositions(a.item.selectionRange.start,b.item.selectionRange.start))[0];
      const key = preferred.item.data.key;
      graph.symbols.set(key,preferred);
      for (const symbol of component) {
        canonical.set(symbol,key);
        if (symbol.declaration) { graph.aliases.set(symbol.declaration.id,key); }
        graph.aliases.set(symbol.item.data.key,key);
      }
    }
  }
  // A shared header may be implemented independently by separate AXEL scripts.
  // Resolve its prototype in the referring document's context, not via a transitive workspace union.
  for (const document of documents) {
    yield;
    const aliases = new Map<string,string>();
    const visible = visibility.get(document.uri)!;
    for (const group of groups.values()) {
      const definitions = group.filter(symbol => symbol.definition && symbol.declaration?.signature && visible.has(symbol.item.uri));
      const distinct = new Set(definitions.map(symbol => canonical.get(symbol)!));
      if (distinct.size !== 1) { continue; }
      const key = distinct.values().next().value!;
      for (const symbol of group) {
        if (symbol.declaration && visible.has(symbol.item.uri) && (symbol.crossFile || symbol.item.uri === document.uri)) {
          aliases.set(symbol.declaration.id,key);
        }
      }
    }
    graph.contextualAliases.set(document.uri,aliases);
  }
  const targetKey = (target: AnalysisDeclaration, uri: string): string | undefined =>
    graph.contextualAliases.get(uri)?.get(target.id) ?? graph.aliases.get(target.id);
  // Navigation scans the source to locate its reference before resolving it. Most references
  // are ordinary variables/fields, so reject names that cannot produce a callable edge first.
  const callableNames = new Set([...graph.symbols.values()].flatMap(symbol =>
    symbol.declaration?.signature ? [symbol.declaration.name,symbol.item.name] : []));
  const selectedKey = query.direction === 'prepare' ? undefined : graph.aliases.get(query.item.data.key) ?? query.item.data.key;
  const selected = selectedKey && graph.symbols.get(selectedKey);
  const incomingNames = query.direction === 'incoming' && selected
    && ['function','method'].includes(selected.item.kind) && !selected.item.name.startsWith('~')
    ? new Set([selected.declaration?.name,selected.item.name]) : undefined;
  for (const document of documents) {
    yield;
    const item = data.get(document.uri)!;
    if (!needsSemanticData(document,item.symbols,analysis,graph,query)) { continue; }
    const semantic = item.semantic ??= document.typeSnapshot
      ? yield* collectSemanticCallData(inputs.get(document.uri)!) : {calls:[],references:[],overrides:[]};
    graph.calls.set(document.uri,semantic.calls);
    graph.references.set(document.uri,semantic.references);
    if (query.direction === 'prepare') { continue; }
    const add = (target: AnalysisDeclaration, range: AnalysisRange, kind: Edge['kind'], expandedPosition?: AnalysisPosition) => {
      if (incomingNames && !incomingNames.has(target.name) || excluded(document,range.start)) { return; }
      const owner = ownerAt(item.symbols,expandedPosition ?? range.start,expandedPosition !== undefined);
      const from = owner && canonical.get(owner);
      if (query.direction === 'outgoing' && from !== selectedKey) { return; }
      const to = targetKey(target,document.uri);
      if (from && to) { addEdge(graph,{from,to,uri:document.uri,range,kind}); }
    };
    for (const call of semantic.calls) {
      yield;
      for (const target of call.targets) { add(target,call.range,'call',call.expandedRange?.start); }
    }
    for (const reference of semantic.references) {
      yield;
      for (const target of reference.targets) { add(target,reference.range,'reference',reference.expandedRange?.start); }
    }
    for (const reference of document.navigationReferences ?? document.references) {
      yield;
      if (!callableNames.has(reference.name) || reference.typeReference || reference.preprocessor
        || excluded(document,reference.range.start)) { continue; }
      if (incomingNames && !incomingNames.has(reference.name)) { continue; }
      if (query.direction === 'outgoing') {
        const owner = ownerAt(item.symbols,reference.range.start);
        if (!owner || canonical.get(owner) !== selectedKey) { continue; }
      }
      if (semantic.references.some(value => rangeKey(value.range) === rangeKey(reference.range))) { continue; }
      if (semantic.calls.some(call => containsSourcePosition(call.range,reference.range.start))) { continue; }
      const navigation = {analysis:document,position:reference.range.start,workspaceIndex};
      const target = reference.call ? findNavigationTargetDeclaration(navigation) : valueTarget(navigation,graph);
      if (!target?.signature || !['function','method'].includes(target.kind)) { continue; }
      add(target,reference.range,reference.call ? 'call' : 'reference');
    }
    for (const relation of semantic.overrides) {
      const derived = targetKey(relation.derived,document.uri), base = targetKey(relation.base,document.uri);
      if (!derived || !base || derived === base) { continue; }
      const bases = graph.bases.get(derived) ?? new Set();
      bases.add(base); graph.bases.set(derived,bases);
    }
  }
  cache.graphs.set(cacheKey,graph);
  // Requests can originate in many files; retain a bounded number of complete context graphs.
  if (cache.graphs.size > 8) { cache.graphs.delete(cache.graphs.keys().next().value!); }
  return graph;
}

function needsSemanticData(document: AnalyzedDocument, symbols: HierarchySymbol[], analysis: AnalyzedDocument,
  graph: Graph, query: GraphQuery): boolean {
  if (query.direction === 'prepare') {
    return document.uri === analysis.uri && !symbols.some(symbol => symbol.item.kind !== 'file'
      && containsSourcePosition(symbol.item.selectionRange,query.position));
  }
  const key = graph.aliases.get(query.item.data.key) ?? query.item.data.key;
  const target = graph.symbols.get(key);
  if (!target) { return false; }
  if (query.direction === 'outgoing') { return document.uri === target.item.uri; }
  // Ordinary function/method uses have a written name, including in expanded macros.
  // Constructors, operators and conversions can be implicit, so retain the full search for them.
  if (!['function','method'].includes(target.item.kind) || target.item.name.startsWith('~')) { return true; }
  const names = new Set([target.item.name,target.declaration?.name]);
  const source = document.expandedSource?.analysis ?? document;
  return document.uri === target.item.uri || source.references.some(reference => names.has(reference.name))
    || source.declarations.some(declaration => declaration.signature && names.has(declaration.name));
}

function publicItem(graph: Graph, key: string, sourceUri: string): AnalysisCallHierarchyItem | undefined {
  const item = graph.symbols.get(key)?.item;
  return item && {...item,data:{key,sourceUri}};
}

export interface CallHierarchyInput {
  item: AnalysisCallHierarchyItem;
  analysis: AnalyzedDocument;
  workspaceIndex: WorkspaceNavigationIndex;
}

export function* prepareCallHierarchySteps(input: NavigationInput): Generator<AnalysisStep, AnalysisCallHierarchyItem[] | null, void> {
  if (excluded(input.analysis,input.position)) { return null; }
  const graph = yield* graphSteps(input.analysis,input.workspaceIndex,{direction:'prepare',position:input.position});
  const keys = new Set<string>();
  const local = graph.byDocument.get(input.analysis.uri) ?? [];
  for (const symbol of local) {
    if (symbol.item.kind !== 'file' && containsSourcePosition(symbol.item.selectionRange,input.position)) {
      keys.add(graph.aliases.get(symbol.item.data.key) ?? symbol.item.data.key);
    }
  }
  if (!keys.size) {
    const references = (graph.references.get(input.analysis.uri) ?? []).filter(reference => containsSourcePosition(reference.range,input.position));
    const calls = [...references, ...(graph.calls.get(input.analysis.uri) ?? []).filter(call =>
      containsSourcePosition(call.range,input.position) && (!references.length
        || references.some(reference => rangeKey(reference.range) === rangeKey(call.range))))];
    for (const call of calls) {
      for (const target of call.targets) {
        const key = graph.contextualAliases.get(input.analysis.uri)?.get(target.id) ?? graph.aliases.get(target.id);
        if (key) { keys.add(key); }
      }
    }
    if (!calls.length) {
      const reference = (input.analysis.navigationReferences ?? input.analysis.references)
        .find(ref => !ref.typeReference && !ref.preprocessor && containsSourcePosition(ref.range,input.position));
      if (reference) {
        const target = reference.call ? findNavigationTargetDeclaration(input) : valueTarget(input,graph);
        const key = target?.signature && graph.aliases.get(target.id);
        if (key) { keys.add(key); }
      }
    }
  }
  const items = [...keys].flatMap(key => publicItem(graph,key,input.analysis.uri) ?? []);
  return items.length ? items : null;
}

export function* incomingCallHierarchySteps(input: CallHierarchyInput): Generator<AnalysisStep, AnalysisCallHierarchyCall[], void> {
  const graph = yield* graphSteps(input.analysis,input.workspaceIndex,{direction:'incoming',item:input.item});
  const key = graph.aliases.get(input.item.data.key) ?? input.item.data.key;
  if (!graph.symbols.has(key)) { return []; }
  const pending = [key], seen = new Set<string>(), edges: Edge[] = [];
  while (pending.length) {
    yield;
    const current = pending.pop()!;
    if (seen.has(current)) { continue; }
    seen.add(current);
    edges.push(...graph.incoming.get(current) ?? []);
    pending.push(...graph.bases.get(current) ?? []);
  }
  return groupCalls(graph,edges,'incoming',input.analysis.uri);
}

export function* outgoingCallHierarchySteps(input: CallHierarchyInput): Generator<AnalysisStep, AnalysisCallHierarchyCall[], void> {
  const graph = yield* graphSteps(input.analysis,input.workspaceIndex,{direction:'outgoing',item:input.item});
  const key = graph.aliases.get(input.item.data.key) ?? input.item.data.key;
  if (!graph.symbols.has(key)) { return []; }
  return groupCalls(graph,graph.outgoing.get(key) ?? [],'outgoing',input.analysis.uri,input.item.uri);
}

function groupCalls(graph: Graph, edges: Edge[], direction: 'incoming' | 'outgoing', sourceUri: string, callerUri?: string): AnalysisCallHierarchyCall[] {
  const calls = new Map<string, AnalysisCallHierarchyCall>();
  const locations = new Map<string, Set<string>>();
  for (const edge of edges) {
    const key = direction === 'incoming' ? edge.from : edge.to;
    const item = publicItem(graph,key,sourceUri);
    if (!item) { continue; }
    let call = calls.get(key);
    if (!call) { call = {item,fromRanges:[]}; calls.set(key,call); locations.set(key,new Set()); }
    const uri = direction === 'incoming' ? item.uri : callerUri;
    const range = rangeKey(edge.range);
    if (edge.uri === uri && !locations.get(key)!.has(range)) { call.fromRanges.push(edge.range); locations.get(key)!.add(range); }
  }
  for (const call of calls.values()) { call.fromRanges.sort((a,b) => comparePositions(a.start,b.start) || comparePositions(a.end,b.end)); }
  return [...calls.values()].sort((a,b) => (a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0)
    || a.item.uri.localeCompare(b.item.uri) || comparePositions(a.item.selectionRange.start,b.item.selectionRange.start));
}
