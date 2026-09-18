import type { AnalysisDeclaration, AnalysisPosition, AnalysisRange, AnalysisSymbol, AnalyzedDocument } from '../types/analysis';
import type { AnalysisCallHierarchyItem } from './callHierarchyModel';
import { comparePositions } from './resolution';
import { containsSourcePosition } from './systemMacros';
import { allGuiMethods } from './guiResolution';
import { field, type TypeNode } from './typeChecking/syntax';
import type { AnalysisStep } from '../util/analysisSteps';

export interface HierarchySymbol {
  declaration?: AnalysisDeclaration;
  item: AnalysisCallHierarchyItem;
  signature: string;
  definition: boolean;
  ownership: AnalysisRange[];
  expandedOwnership?: AnalysisRange[];
  expandedRange?: AnalysisRange;
  crossFile?: boolean;
}

export function rangeKey(range: AnalysisRange): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

export function sourceRange(document: AnalyzedDocument, range: AnalysisRange): AnalysisRange {
  return document.expandedSource?.sourceRange(range) ?? range;
}

export function excluded(document: AnalyzedDocument, position: AnalysisPosition): boolean {
  return [...document.inactiveRanges ?? [], ...document.uncertainRanges ?? [],
    ...document.syntaxRecovery?.ranges ?? [], ...document.syntaxRecovery?.dependentReferences ?? []]
    .some(range => containsSourcePosition(range, position));
}

function covers(outer: AnalysisRange, inner: AnalysisRange): boolean {
  return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}

/** Declarator shape is taken from syntax fields, excluding parameter names and default values. */
function parameterShape(node: TypeNode | undefined): string {
  if (!node) { return ''; }
  if (node.kind === 'identifier') { return ''; }
  if (node.kind === 'init_declarator') { return parameterShape(field(node, 'declarator')); }
  if (node.kind === 'parameter_declaration') {
    return [field(node, 'type')?.text, field(node, 'class_modifier')?.text,
      field(node, 'storage_class_specifier')?.text, parameterShape(field(node, 'declarator'))].join(':');
  }
  if (node.kind === 'parameter_list') {
    const parameters = node.children.filter(n => n.kind !== 'comment');
    if (parameters.length === 1 && field(parameters[0], 'type')?.text === 'void' && !field(parameters[0], 'declarator')) { return ''; }
    return parameters.map(parameterShape).join(',');
  }
  const child = field(node, 'declarator');
  const params = field(node, 'parameters');
  return `${node.kind}:${node.kind.includes('pointer') ? node.text.trimStart()[0] : ''}:${child ? parameterShape(child) : ''}:${params ? parameterShape(params) : ''}`;
}

function callableParameters(node: TypeNode | undefined): string {
  if (!node) { return ''; }
  const params = field(node, 'parameters');
  if (params) { return parameterShape(params); }
  return callableParameters(field(node, 'declarator') ?? field(node, 'name'));
}

function qualifiedName(node: TypeNode | undefined): string | undefined {
  if (!node) { return undefined; }
  if (node.kind === 'qualified_declarator') { return node.fields.name?.map(part=>part.text).join(''); }
  return qualifiedName(field(node,'declarator'));
}

function flattenSymbols(symbols: AnalysisSymbol[]): AnalysisSymbol[] {
  return symbols.flatMap(symbol => [symbol, ...flattenSymbols(symbol.children ?? [])]);
}

export function* collectHierarchySymbols(document: AnalyzedDocument, sourceUri: string): Generator<AnalysisStep, HierarchySymbol[], void> {
  const root = (document.expandedSource?.analysis ?? document).typeSnapshot?.root;
  if (!root) { return []; }
  const syntaxByRange = new Map<string, {node:TypeNode; enclosingFunction?:TypeNode; enclosingClass?:TypeNode}[]>();
  const pending: {node:TypeNode; enclosingFunction?:TypeNode; enclosingClass?:TypeNode}[] = [{node:root}];
  let visited = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    const {node} = entry;
    if (['function_definition','object_definition','field_declaration'].includes(node.kind)) {
      const key = rangeKey(sourceRange(document,node.range));
      const list = syntaxByRange.get(key) ?? [];
      list.push(entry); syntaxByRange.set(key,list);
    }
    const enclosingFunction = node.kind === 'function_definition' ? node : entry.enclosingFunction;
    const enclosingClass = ['class_specifier','struct_specifier','union_specifier'].includes(node.kind) ? node : entry.enclosingClass;
    for (const child of node.children) { pending.push({node:child,enclosingFunction,enclosingClass}); }
    if (++visited % 128 === 0) { yield; }
  }
  const symbolsByRange = new Map<string,AnalysisSymbol[]>();
  for (const symbol of flattenSymbols(document.symbols)) {
    const key = rangeKey(symbol.range);
    const list = symbolsByRange.get(key) ?? [];
    list.push(symbol); symbolsByRange.set(key,list);
  }
  const declarations = document.declarations;
  const expandedDeclarations = new Map(document.expandedSource?.analysis.declarations.map(declaration=>[declaration.id,declaration]) ?? []);
  const result: HierarchySymbol[] = [];
  for (const declaration of declarations) {
    yield;
    if (excluded(document, declaration.selectionRange.start)) { continue; }
    const callable = !!declaration.signature && ['function', 'method'].includes(declaration.kind);
    if (!callable && !['variable', 'field'].includes(declaration.kind)) { continue; }
    const expandedDeclaration = expandedDeclarations.get(declaration.id);
    const metadata = (syntaxByRange.get(rangeKey(declaration.range)) ?? [])
      .filter(entry => expandedDeclaration ? covers(entry.node.range,expandedDeclaration.selectionRange)
        : covers(sourceRange(document,entry.node.range),declaration.selectionRange))
      .sort((a,b) => (a.node.end-a.node.start)-(b.node.end-b.node.start))[0];
    if (!metadata) { continue; }
    const {node:syntax,enclosingFunction,enclosingClass} = metadata;
    const localClassField = enclosingFunction && enclosingClass && enclosingFunction.start < enclosingClass.start;
    if (!callable && enclosingFunction && !localClassField) { continue; }
    const candidates = symbolsByRange.get(rangeKey(declaration.range)) ?? [];
    const display = candidates.find(symbol => symbol.name === declaration.name && covers(symbol.selectionRange,declaration.selectionRange))
      ?? candidates.find(symbol => covers(symbol.selectionRange, declaration.selectionRange)
      && covers(declaration.range, symbol.selectionRange));
    const name = display?.name ?? declaration.name;
    const signatureName = qualifiedName(field(syntax,'declarator')) ?? declaration.name;
    const signature = JSON.stringify([declaration.containerName ?? '', signatureName.replace(/\s+/g, ''),
      callable ? callableParameters(field(syntax, 'declarator')) : declaration.kind]);
    const enclosingDeclarator = enclosingFunction && field(enclosingFunction,'declarator');
    const localScope = enclosingDeclarator?.text;
    const key = JSON.stringify([declaration.uri, signature, localScope ?? null]);
    const selectionRange = display?.selectionRange ?? declaration.selectionRange;
    const range = {start: comparePositions(declaration.range.start, selectionRange.start) < 0 ? declaration.range.start : selectionRange.start,
      end:comparePositions(declaration.range.end, selectionRange.end) > 0 ? declaration.range.end : selectionRange.end};
    const body = field(syntax, 'body');
    let expandedOwnership = body ? [body.range] : [];
    if (callable && body) {
      // Includes explicitly written constructor member-initializer expressions, but not defaults in parameters.
      expandedOwnership = [{start:(field(syntax,'declarator')?.range ?? syntax.range).end,end:syntax.range.end}];
    }
    if (!callable) {
      const declarator = (syntax.fields.declarator ?? []).find(node => covers(sourceRange(document, node.range), declaration.selectionRange));
      expandedOwnership = declarator ? [declarator.range] : [];
    }
    const ownership = expandedOwnership.map(range => sourceRange(document,range));
    result.push({declaration, signature, definition:!!body, ownership, expandedOwnership,expandedRange:syntax.range,
      crossFile:callable && !enclosingFunction && (!!declaration.containerName
        || !(field(syntax,'storage_class_specifier')?.text.split(/\s+/).includes('static'))),
      item:{name, kind:display?.kind ?? declaration.kind, detail:declaration.containerName
        ? `${declaration.containerName}: ${declaration.detail}` : declaration.detail,
      uri:declaration.uri, range, selectionRange, data:{key, sourceUri}}});
  }
  const expandedGuiMethods = document.expandedSource ? allGuiMethods(document.expandedSource.analysis) : [];
  for (const method of allGuiMethods(document)) {
    if (!method.selectionRange || excluded(document, method.selectionRange.start)) { continue; }
    const expandedMethod = expandedGuiMethods.find(candidate => candidate.name === method.name
      && JSON.stringify(candidate.receiverPath) === JSON.stringify(method.receiverPath)
      && rangeKey(sourceRange(document,candidate.range)) === rangeKey(method.range));
    const expandedOwnership = [expandedMethod?.range ?? method.range];
    const existing = result.find(symbol => symbol.item.name === method.name
      && (covers(symbol.item.selectionRange, method.selectionRange!)
      || covers(method.selectionRange!, symbol.item.selectionRange)));
    if (existing) { existing.ownership = [method.range]; existing.expandedOwnership = expandedOwnership; continue; }
    const name = method.name;
    const signature = JSON.stringify(['gui', method.receiverPath, name]);
    result.push({signature, definition:true, ownership:[method.range], expandedOwnership, item:{name, kind:'method',
      detail:method.receiverPath.join('.'), uri:document.uri, range:method.range,
      selectionRange:method.selectionRange, data:{key:JSON.stringify([document.uri, signature]),sourceUri}}});
  }
  const range = sourceRange(document, root.range);
  const name = decodeURIComponent(document.uri.split('/').at(-1) ?? document.uri);
  result.push({signature:document.uri, definition:true, ownership:[range], expandedOwnership:[root.range], item:{name, kind:'file', uri:document.uri,
    range, selectionRange:{start:range.start,end:range.start}, data:{key:JSON.stringify(['file',document.uri]),sourceUri}}});
  return result;
}

export function ownerAt(symbols: HierarchySymbol[], position: AnalysisPosition, expanded = false): HierarchySymbol | undefined {
  let found: { symbol: HierarchySymbol; range: AnalysisRange } | undefined;
  for (const symbol of symbols) {
    for (const range of expanded ? symbol.expandedOwnership ?? symbol.ownership : symbol.ownership) {
      if (containsSourcePosition(range, position) && (!found || covers(found.range, range))) { found = {symbol,range}; }
    }
  }
  if (found?.symbol.item.kind === 'file' && symbols.some(symbol => symbol.declaration?.signature
    && containsSourcePosition(expanded ? symbol.expandedRange ?? symbol.item.range : symbol.item.range,position))) { return undefined; }
  return found?.symbol;
}
