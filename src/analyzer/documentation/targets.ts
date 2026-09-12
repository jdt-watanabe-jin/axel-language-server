import type { AnalysisDeclaration, AnalyzedDocument, AnalysisRange } from '../../types/analysis';
import { createAxelParser } from '../axelParser';
import { buildSymbolIndex } from '../symbolIndex';
import { contains } from '../resolution';
import { buildTypeContext, resolveType, lookupClass } from '../typeChecking/declarations';
import type { Type, TypeContext, Scope, FunctionInfo } from '../typeChecking/model';
import { buildTypeSnapshot, descendants, field, type TypeNode } from '../typeChecking/syntax';
import type { DocumentationBlock } from './model';

const emptyCatalog = { declarationUris: new Set<string>(), rolesByDeclaration: new Map<string, string>(), analysisOnlyMacroUris: new Set<string>() };
const parser = createAxelParser();

export function createDocumentationTargetResolver(source: AnalyzedDocument, documents: readonly AnalyzedDocument[], visible: readonly AnalysisDeclaration[]) {
  const context = buildTypeContext({ analysis: source, documents, catalog: emptyCatalog });
  const functions = new Map<string, FunctionInfo>();
  const functionsByPosition = new Map(context.bindings.flatMap(binding => binding.type.call ? [[
    `${binding.uri}:${binding.node.range.start.line}:${binding.node.range.start.character}:${binding.name}`,
    binding.type.call,
  ] as const] : []));
  const bindingsByPosition = new Map(context.bindings.map(binding => [
    `${binding.uri}:${binding.node.range.start.line}:${binding.node.range.start.character}:${binding.name}`,
    binding,
  ]));
  const declarationsByName = new Map<string, AnalysisDeclaration[]>();
  for (const d of visible) {
    const name = d.name.replace(/\s/g, '');
    const group = declarationsByName.get(name) ?? [];
    group.push(d); declarationsByName.set(name, group);
  }
  const scopeCache = new Map<string, Scope | undefined>();
  for (const declaration of visible) {
    const fn = functionsByPosition.get(`${declaration.uri}:${declaration.range.start.line}:${declaration.range.start.character}:${declaration.name}`);
    if (fn) { functions.set(declaration.id, fn); }
  }
  function resolve(block: DocumentationBlock, origin: AnalyzedDocument): readonly AnalysisDeclaration[] {
    if (block.document.targets.length !== 1) { return []; }
    const target = block.document.targets[0];
    const text = target.text.trim();
    const scopeKey = `${origin.uri}:${block.scopeId}`;
    if (!scopeCache.has(scopeKey)) { scopeCache.set(scopeKey, scopeAt(context, origin.uri, block.document.source.range)); }
    const scope = scopeCache.get(scopeKey);
    if (!scope || !text) { return []; }
    if (target.kind === 'class' || target.kind === 'def' || target.kind === 'typedef' || target.kind === 'var') {
      // A standalone name is also the documented shorthand for these targets.
      const nameTree = parser.parse(text);
      const identifiers = nameTree.rootNode.descendantsOfType(['identifier', 'class_name']);
      const nameOnly = identifiers.length === 1 && identifiers[0].text === text;
      const name = nameOnly ? text : undefined;
      if (name) {
        const kind = target.kind === 'class' ? 'class' : target.kind === 'def' ? 'macro' : target.kind === 'var' ? 'variable' : 'typedef';
        const candidates = preferScope((declarationsByName.get(name) ?? []).filter(d => target.kind === 'var' ? ['variable', 'field', 'enumMember'].includes(d.kind) : d.kind === kind), origin, scope, block.scopeId);
        return target.kind === 'var' && scope.owner
          ? candidates.filter(d => bindingFor(d)?.scope.owner?.id === scope.owner!.id)
          : candidates;
      }
    }
    const declarationText = target.kind === 'typedef' && !text.startsWith('typedef ') ? `typedef ${text}` : text;
    let tree = parser.parse(declarationText.endsWith(';') ? declarationText : `${declarationText};`);
    let node = tree.rootNode.namedChildren.find(n => n.type !== 'comment');
    if (tree.rootNode.hasError && target.kind === 'fn') {
      tree = parser.parse(`class ${scope.owner?.name ?? '__Doxygen'} { public: ${declarationText}; };`);
      node = tree.rootNode.descendantsOfType('field_declaration')[0];
    }
    if (!node || tree.rootNode.hasError) { return []; }
    const parsed = buildSymbolIndex(node, origin.uri).declarations.filter(d => d.kind !== 'parameter');
    if (parsed.length !== 1) { return []; }
    const requested = parsed[0];
    const expectedKind = target.kind === 'fn' ? 'function' : target.kind === 'var' ? 'variable' : target.kind;
    if (requested.kind !== expectedKind && !(target.kind === 'var' && ['field', 'enumMember'].includes(requested.kind))) { return []; }
    const qualified = node.descendantsOfType('qualified_declarator')[0]?.childForFieldName('scope')?.text;
    const owner = qualified ? lookupClass(context, qualified, scope) : scope.owner;
    if (qualified && !owner) { return []; }
    const candidates = preferScope((declarationsByName.get(requested.name.replace(/\s/g, '')) ?? []).filter(d => (target.kind === 'var' ? ['variable', 'field', 'enumMember'].includes(d.kind) : d.kind === requested.kind)
      && (qualified ? d.containerName === owner?.name : true)), origin, qualified ? owner!.scope : scope, block.scopeId);
    const snapshot = buildTypeSnapshot(node, origin.uri).root;
    const requestedType = resolveType(context, snapshot, owner?.scope ?? scope);
    if (target.kind === 'fn') {
      if (!requestedType.call) { return []; }
      const matching = candidates.filter(d => {
        const actual = functions.get(d.id);
        return actual && (!owner || actual.owner?.id === owner.id)
          && equivalentParameters(context, requestedType.call!, actual, snapshot, actual.node);
      });
      // Return types validate a declaration; they cannot disambiguate overloads.
      if (matching.some(d => {
        const actual = functions.get(d.id)!;
        return !equivalentType(context, requestedType.call!.result, actual.result, field(snapshot, 'type'), field(actual.node, 'type'));
      })) { return []; }
      return matching;
    }
    if (target.kind === 'var') {
      return candidates.filter(d => {
        const actual = bindingFor(d);
        return actual && (!owner || actual.scope.owner?.id === owner.id)
          && equivalentType(context, requestedType, actual.type, snapshot, actual.node);
      });
    }
    return candidates;
  }
  function bindingFor(declaration: AnalysisDeclaration) {
    return bindingsByPosition.get(`${declaration.uri}:${declaration.range.start.line}:${declaration.range.start.character}:${declaration.name}`);
  }
  function equivalent(left: AnalysisDeclaration, right: AnalysisDeclaration): boolean {
    if (left.id === right.id) { return true; }
    if (left.kind !== 'function' || right.kind !== 'function' || left.name !== right.name || left.containerName !== right.containerName) { return false; }
    const a = functions.get(left.id), b = functions.get(right.id);
    if (!a || !b || !equivalentFunction(context, a, b, a.node, b.node)) { return false; }
    if (a.owner || b.owner) { return a.owner?.id === b.owner?.id; }
    return (!a.scope.parent && !b.scope.parent) || a.scope === b.scope
      || (a.node.kind === 'function_definition' && a.scope.parent === b.scope)
      || (b.node.kind === 'function_definition' && b.scope.parent === a.scope);
  }
  return { resolve, equivalent };
}

export function resolveDocumentationTarget(block: DocumentationBlock, source: AnalyzedDocument,
  documents: readonly AnalyzedDocument[], visible: readonly AnalysisDeclaration[]): readonly AnalysisDeclaration[] {
  return createDocumentationTargetResolver(source, documents, visible).resolve(block, source);
}

function scopeAt(ctx: TypeContext, uri: string, range: AnalysisRange): Scope | undefined {
  return ctx.scopes.filter(s => s.uri === uri && contains(s.node.range, range.start))
    .sort((a, b) => (a.node.end - a.node.start) - (b.node.end - b.node.start) || scopeDepth(b) - scopeDepth(a))[0];
}
function scopeDepth(scope: Scope): number {
  let depth = 0;
  for (let current = scope.parent; current; current = current.parent) { depth++; }
  return depth;
}
function preferScope(candidates: readonly AnalysisDeclaration[], origin: AnalyzedDocument, scope: Scope, scopeId: string): AnalysisDeclaration[] {
  const localScope = origin.scopes.find(candidate => candidate.id === scopeId);
  if (scope.parent && localScope) {
    const local = candidates.filter(d => localScope.declarationIds.includes(d.id));
    if (local.length) { return local; }
  }
  if (scope.owner) { return candidates.filter(d => d.containerName === scope.owner!.name); }
  const global = candidates.filter(d => !d.containerName);
  const local = global.filter(d => d.uri === origin.uri);
  return local.length ? local : global;
}
function equivalentFunction(context: TypeContext, a: FunctionInfo, b: FunctionInfo, aNode: TypeNode, bNode: TypeNode): boolean {
  return equivalentType(context, a.result, b.result, field(aNode, 'type'), field(bNode, 'type'))
    && equivalentParameters(context, a, b, aNode, bNode);
}
function equivalentParameters(context: TypeContext, a: FunctionInfo, b: FunctionInfo, aNode: TypeNode, bNode: TypeNode): boolean {
  if (a.variadic !== b.variadic || a.parameters.length !== b.parameters.length) { return false; }
  const ap = parameterNodes(aNode), bp = parameterNodes(bNode);
  if (!a.parameters.every((t, i) => equivalentType(context, t, b.parameters[i], ap[i], bp[i]))) { return false; }
  const av = variadicParameterNode(aNode), bv = variadicParameterNode(bNode);
  if ((av === undefined) !== (bv === undefined)) { return false; }
  return av === undefined || equivalentType(
    context,
    resolveType(context, av, a.scope),
    resolveType(context, bv, b.scope),
    av,
    bv,
  );
}
function parameterNodes(node: TypeNode): TypeNode[] {
  const list = descendants(node, 'parameter_list')[0];
  return list?.children.filter(n => n.kind === 'parameter_declaration' && !n.variadic) ?? [];
}
function variadicParameterNode(node: TypeNode): TypeNode | undefined {
  const list = descendants(node, 'parameter_list')[0];
  return list?.children.find(child => child.kind === 'parameter_declaration' && child.variadic);
}
function equivalentType(context: TypeContext, a: Type, b: Type, an?: TypeNode, bn?: TypeNode): boolean {
  if (a.kind !== b.kind || !!a.const !== !!b.const) { return false; }
  if (a.kind === 'unknown') {
    // Unresolved types never compare equal just because both became `unknown`.
    // Identical written type syntax can still document declarations without their header.
    return !!an && !!bn && writtenType(an) !== '' && writtenType(an) === writtenType(bn);
  }
  if (a.kind === 'class') { return a.classInfo?.id === b.classInfo?.id; }
  if (a.element || b.element) { return !!a.element && !!b.element && equivalentType(context, a.element, b.element, an, bn); }
  if (a.call || b.call) { return !!a.call && !!b.call && equivalentFunction(context, a.call, b.call, an ?? a.call.node, bn ?? b.call.node); }
  return a.name === b.name;
}
function writtenType(node: TypeNode): string {
  if (node.kind === 'identifier') { return ''; }
  if (node.kind === 'class_name' || node.kind === 'primitive_type' || node.kind === 'type_identifier') { return node.text; }
  if (node.kind === 'init_declarator') { const child = field(node, 'declarator'); return child ? writtenType(child) : ''; }
  return `${node.kind}(${node.children.filter(n => n.kind !== 'comment').map(writtenType).join(',')})`;
}
