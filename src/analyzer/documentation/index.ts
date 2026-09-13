import type * as Parser from 'tree-sitter';
import type { AnalysisDeclaration, AnalysisPosition, AnalyzedDocument } from '../../types/analysis';
import { contains, comparePositions } from '../resolution';
import { extractDocumentationComments } from './comments';
import { parseDocumentation } from './parse';
import { createDocumentationTargetResolver } from './targets';
import type { BoundDocumentation, DocumentationBindings, DocumentationBlock, DocParameter, ParsedDocumentation } from './model';

export function buildDocumentationBlocks(root: Parser.SyntaxNode, text: string, analysis: AnalyzedDocument): DocumentationBlock[] {
  const comments = extractDocumentationComments(root, text, analysis.uri);
  const commentNodes = root.descendantsOfType('comment');
  const allowedComments = new Set(comments.filter(c => c.placement === 'leading').map(c => positionKey(c.source.range.start)));
  const result: DocumentationBlock[] = [];
  for (const comment of comments) {
    if (comment.placement !== 'leading' || [...(analysis.inactiveRanges ?? []), ...(analysis.uncertainRanges ?? [])].some(r => contains(r, comment.source.range.start))) { continue; }
    const document = parseDocumentation(comment);
    const scope = analysis.scopes.filter(s => contains(s.range, comment.source.range.start))
      .sort((a, b) => comparePositions(b.range.start, a.range.start) || comparePositions(a.range.end, b.range.end))[0];
    let last = commentNodes.filter(n => contains(comment.source.range, {line:n.startPosition.row, character:n.startPosition.column})).at(-1);
    // The end of the last // line belongs to the group, but the next source line does not.
    let next = last?.nextNamedSibling;
    while (next?.type === 'comment' && allowedComments.has(positionKey({line:next.startPosition.row,character:next.startPosition.column}))) {
      const following = comments.find(c => positionKey(c.source.range.start) === positionKey({line:next!.startPosition.row, character:next!.startPosition.column}));
      if (!following || parseDocumentation(following).groups.some(g => g.kind !== 'ingroup')) { break; }
      last = next; next = next.nextNamedSibling;
    }
    const adjacent = next && next.type !== 'comment' && !next.type.startsWith('preproc_')
      ? analysis.declarations.filter(d => d.kind !== 'parameter'
        && comparePositions(d.range.start, {line:next!.startPosition.row, character:next!.startPosition.column}) === 0)
      : next && ['preproc_def', 'preproc_function_def'].includes(next.type)
        ? analysis.declarations.filter(d => d.kind === 'macro' && comparePositions(d.range.start, {line:next!.startPosition.row, character:next!.startPosition.column}) === 0) : [];
    result.push({document, scopeId:scope?.id ?? '', adjacentDeclarationIds:adjacent.map(d => d.id)});
  }
  return result;
}

export function bindDocumentation(source: AnalyzedDocument, documents: readonly AnalyzedDocument[], visible: readonly AnalysisDeclaration[]): DocumentationBindings {
  const origins = [...new Map([...documents, source].map(d => [d.uri, d])).values()];
  if (!origins.some(d => d.documentationBlocks?.length)) { return new Map(); }
  const resolver = createDocumentationTargetResolver(source, origins, visible);
  const visibleById = new Map(visible.map(d => [d.id, d]));
  const proposals = new Map<string, {block:DocumentationBlock; direct:boolean}[]>();
  for (const origin of origins) {
    for (const block of origin.documentationBlocks ?? []) {
      if (block.document.groups.some(g => g.kind !== 'ingroup')) { continue; }
      const adjacent = block.adjacentDeclarationIds.map(id => visibleById.get(id))
        .filter((d): d is AnalysisDeclaration => d !== undefined);
      // Like cpptools, a leading function comment documents its actual neighbor.
      // An incomplete or conflicting fn does not discard the attached description.
      const directFunction = block.document.targets.length > 0
        && block.document.targets.every(target => target.kind === 'fn')
        ? adjacent.filter(d => d.kind === 'function' || d.kind === 'method') : [];
      const candidates = directFunction.length ? directFunction : block.document.targets.length
        ? resolver.resolve(block, origin) : adjacent;
      if (!candidates.length || (candidates.length > 1 && !candidates.every(d => resolver.equivalent(candidates[0], d)))) { continue; }
      for (const declaration of candidates) {
        const entries = proposals.get(declaration.id) ?? [];
        entries.push({block, direct:block.adjacentDeclarationIds.includes(declaration.id)});
        proposals.set(declaration.id, entries);
      }
    }
  }
  const result = new Map<string, BoundDocumentation>();
  for (const declaration of visible) {
    const entries = proposals.get(declaration.id) ?? [];
    const direct = entries.filter(e => e.direct);
    const selected = direct.length ? direct : !declaration.documentation?.trim() && entries.length === 1 ? entries : [];
    if (selected.length) {
      // An explicit target can name both a prototype and a definition. Parameter
      // names belong to the declaration carrying the description; transfer the
      // established positions when presenting an equivalent declaration.
      const anchors = [...new Set(selected.flatMap(e => e.block.adjacentDeclarationIds))]
        .map(id => visibleById.get(id))
        .filter((d): d is AnalysisDeclaration => !!d && resolver.equivalent(declaration, d));
      const anchor = anchors.length === 1 ? anchors[0] : declaration;
      result.set(declaration.id, { ...bindParameters(anchor, selected.map(e => e.block.document)), declaration });
    }
  }
  const documentedByName = new Map<string, AnalysisDeclaration[]>();
  for (const d of visible) {
    if (!result.has(d.id)) { continue; }
    const group = documentedByName.get(d.name) ?? []; group.push(d); documentedByName.set(d.name, group);
  }
  // A declaration with no usable description can borrow a unique equivalent definition's description.
  for (const declaration of visible) {
    if (result.has(declaration.id) || proposals.has(declaration.id) || declaration.documentation?.trim()) { continue; }
    const alternatives = (documentedByName.get(declaration.name) ?? []).filter(d => resolver.equivalent(declaration, d));
    if (alternatives.length === 1) {
      const borrowed = result.get(alternatives[0].id)!;
      result.set(declaration.id, { ...borrowed, declaration });
    }
  }
  return result;
}

function bindParameters(declaration: AnalysisDeclaration, documents: ParsedDocumentation[]): BoundDocumentation {
  const parameterEntries = new Map<number, DocParameter[]>();
  const unmatchedParameters: DocParameter[] = [];
  const parameters = declaration.signature?.parameters ?? [];
  let unnamed = 0;
  for (const entry of documents.flatMap(d => d.parameters)) {
    let unmatched = false;
    for (const name of entry.names) {
      let index = -1;
      if (name === '...') { index = parameters.findIndex(p => p.variadic); }
      else if (name === '-') {
        while (unnamed < parameters.length && (parameters[unnamed].name || parameters[unnamed].variadic)) { unnamed++; }
        index = unnamed++;
      } else if (/^[1-9]\d*$/.test(name)) {
        const position = Number(name) - 1;
        if (!parameters[position]?.name) { index = position; }
      } else { index = parameters.findIndex(p => p.name === name); }
      if (index < 0 || index >= parameters.length) { unmatched = true; continue; }
      const previous = parameterEntries.get(index) ?? [];
      if (!previous.includes(entry)) { previous.push(entry); }
      parameterEntries.set(index, previous);
    }
    if (unmatched || !entry.names.length) { unmatchedParameters.push(entry); }
  }
  return {declaration, documents, parameterEntries, unmatchedParameters};
}
function positionKey(position: AnalysisPosition): string { return `${position.line}:${position.character}`; }
