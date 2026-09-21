import type * as Parser from 'tree-sitter';
import type { AnalysisStep } from '../util/analysisSteps';

export interface FoldingRangeCandidate {
  startLine: number;
  endLine: number;
  kind?: 'comment' | 'region';
}

const bracedBodies = new Set([
  'compound_statement',
  'field_declaration_list',
  'enumerator_list',
  'initializer_list',
  'gins_definition'
]);
const conditionalStarts = new Set(['preproc_if', 'preproc_ifdef']);
const conditionalBranches = new Set(['preproc_elif', 'preproc_elifdef', 'preproc_else']);
const unbracedBodyFields = new Map([
  ['if_statement', 'consequence'],
  ['while_statement', 'body'],
  ['do_statement', 'body'],
  ['for_statement', 'body']
]);

/** Collect syntax-only folding candidates from one physical source tree. */
export function* collectFoldingRangesSteps(root: Parser.SyntaxNode, text: string):
Generator<AnalysisStep, FoldingRangeCandidate[], void> {
  yield;
  const lines = text.split('\n');
  const candidates: FoldingRangeCandidate[] = [];
  const regionStarts: Parser.SyntaxNode[] = [];
  const missingEndpointCache = new Map<number, boolean>();
  const nextSyntaxCache = new Map<number, Parser.SyntaxNode | null>();
  const stack: Parser.SyntaxNode[] = [root];
  let visited = 0;

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (++visited % 256 === 0) { yield; }

    // A subtree on one physical line cannot contain a folding range. Region directives
    // still participate in pairing even though each marker itself occupies one line.
    if (node.startPosition.row === node.endPosition.row && node.type !== 'preproc_call') { continue; }
    const candidate = candidateForNode(node, lines, missingEndpointCache, nextSyntaxCache);
    if (candidate !== undefined) { candidates.push(candidate); }

    if (node.type === 'preproc_call' && startsAfterIndentation(node, lines)) {
      const directive = node.childForFieldName('directive')?.text;
      if (directive !== undefined && /^#[ \t]*region\b/.test(directive)) {
        regionStarts.push(node);
      } else if (directive !== undefined && /^#[ \t]*endregion\b/.test(directive)) {
        const start = regionStarts.pop();
        if (start !== undefined) {
          candidates.push({ startLine: start.startPosition.row,
            endLine: node.startPosition.row - 1, kind: 'region' });
        }
      }
    }

    for (let index = node.childCount - 1; index >= 0; index -= 1) {
      const child = node.child(index);
      if (child !== null) { stack.push(child); }
    }
  }

  return yield* normalizeCandidates(candidates, lines.length);
}

function candidateForNode(node: Parser.SyntaxNode, lines: readonly string[],
  missingEndpointCache: Map<number, boolean>, nextSyntaxCache: Map<number, Parser.SyntaxNode | null>):
FoldingRangeCandidate | undefined {
  if (bracedBodies.has(node.type)) { return bracedCandidate(node); }
  if (node.type === 'comment') { return commentCandidate(node, lines); }
  if (conditionalStarts.has(node.type)) { return conditionalCandidate(node); }
  if (conditionalBranches.has(node.type)) { return conditionalBranchCandidate(node); }
  if (node.type === 'preproc_def' || node.type === 'preproc_function_def') {
    if (node.children.some(child => child.type === 'unterminated_comment')) { return undefined; }
    return { startLine: node.startPosition.row, endLine: contentEndLine(node) };
  }
  if (node.type === 'else_clause') { return elseCandidate(node, missingEndpointCache, nextSyntaxCache); }

  const field = unbracedBodyFields.get(node.type);
  if (field === undefined || (node.type === 'if_statement' && node.parent?.type === 'else_clause')) {
    return undefined;
  }
  const body = node.childForFieldName(field);
  return body === null || bracedBodies.has(body.type)
    ? undefined : unbracedCandidate(node.startPosition.row, body, missingEndpointCache, nextSyntaxCache);
}

function bracedCandidate(node: Parser.SyntaxNode): FoldingRangeCandidate | undefined {
  let open: Parser.SyntaxNode | undefined;
  let close: Parser.SyntaxNode | undefined;
  for (const child of node.children) {
    if (child.isMissing) { continue; }
    if (open === undefined && child.type === '{') { open = child; }
    if (child.type === '}') { close = child; }
  }
  return open === undefined || close === undefined || open.endIndex > close.startIndex
    ? undefined : { startLine: open.startPosition.row, endLine: close.startPosition.row - 1 };
}

function unbracedCandidate(startLine: number, body: Parser.SyntaxNode,
  missingEndpointCache: Map<number, boolean>, nextSyntaxCache: Map<number, Parser.SyntaxNode | null>):
FoldingRangeCandidate | undefined {
  if (body.isMissing || body.type === 'ERROR' || hasMissingEndpoint(body, missingEndpointCache)) { return undefined; }
  let endLine = contentEndLine(body);
  if (hasTrailingSyntax(body, nextSyntaxCache)) { endLine -= 1; }
  return { startLine, endLine };
}

function elseCandidate(node: Parser.SyntaxNode, missingEndpointCache: Map<number, boolean>,
  nextSyntaxCache: Map<number, Parser.SyntaxNode | null>): FoldingRangeCandidate | undefined {
  const statement = node.namedChildren.find(child => !child.isExtra && child.type !== 'comment');
  if (statement === undefined) { return undefined; }
  if (statement.type !== 'if_statement') {
    return bracedBodies.has(statement.type)
      ? undefined : unbracedCandidate(node.startPosition.row, statement, missingEndpointCache, nextSyntaxCache);
  }
  const consequence = statement.childForFieldName('consequence');
  return consequence === null || bracedBodies.has(consequence.type)
    ? undefined : unbracedCandidate(node.startPosition.row, consequence, missingEndpointCache, nextSyntaxCache);
}

function commentCandidate(node: Parser.SyntaxNode, lines: readonly string[]): FoldingRangeCandidate | undefined {
  if (!node.text.startsWith('/*') || !node.text.endsWith('*/')) { return undefined; }
  let endLine = node.endPosition.row;
  if (hasTrailingContent(node, lines)) { endLine -= 1; }
  return { startLine: node.startPosition.row, endLine, kind: 'comment' };
}

function conditionalCandidate(node: Parser.SyntaxNode): FoldingRangeCandidate | undefined {
  const close = node.children.find(child => child.type === '#endif' && !child.isMissing);
  return close === undefined ? undefined
    : { startLine: node.startPosition.row, endLine: close.startPosition.row - 1 };
}

function conditionalBranchCandidate(node: Parser.SyntaxNode): FoldingRangeCandidate | undefined {
  const next = node.childForFieldName('alternative');
  if (next !== null) {
    return { startLine: node.startPosition.row, endLine: next.startPosition.row - 1 };
  }
  let owner = node.parent;
  while (owner !== null && !conditionalStarts.has(owner.type)) { owner = owner.parent; }
  if (owner === null) { return undefined; }
  const close = owner.children.find(child => child.type === '#endif' && !child.isMissing);
  return close === undefined ? undefined
    : { startLine: node.startPosition.row, endLine: close.startPosition.row - 1 };
}

function contentEndLine(node: Parser.SyntaxNode): number {
  return node.endPosition.column === 0 && node.endPosition.row > node.startPosition.row
    ? node.endPosition.row - 1 : node.endPosition.row;
}

function hasTrailingContent(node: Parser.SyntaxNode, lines: readonly string[]): boolean {
  if (node.endPosition.column === 0) { return false; }
  const line = lines[node.endPosition.row]?.replace(/\r$/, '');
  if (line === undefined) { return false; }
  return line.slice(node.endPosition.column).trim().length > 0;
}

function hasTrailingSyntax(node: Parser.SyntaxNode,
  cache: Map<number, Parser.SyntaxNode | null>): boolean {
  return nextSyntaxAfter(node, cache)?.startPosition.row === contentEndLine(node);
}

function nextSyntaxAfter(node: Parser.SyntaxNode,
  cache: Map<number, Parser.SyntaxNode | null>): Parser.SyntaxNode | null {
  const path: number[] = [];
  let current: Parser.SyntaxNode | null = node;
  let result: Parser.SyntaxNode | null = null;
  while (current !== null) {
    if (cache.has(current.id)) {
      result = cache.get(current.id)!;
      break;
    }
    path.push(current.id);
    let sibling = current.nextSibling;
    while (sibling !== null && (sibling.isExtra || sibling.type === 'comment')) {
      sibling = sibling.nextSibling;
    }
    if (sibling !== null) {
      result = sibling;
      break;
    }
    current = current.parent;
  }
  for (const id of path) { cache.set(id, result); }
  return result;
}

function hasMissingEndpoint(node: Parser.SyntaxNode, cache: Map<number, boolean>): boolean {
  const path: number[] = [];
  let current: Parser.SyntaxNode | null = node;
  let result = false;
  while (current !== null) {
    const cached = cache.get(current.id);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    path.push(current.id);
    if (current.isMissing) {
      result = true;
      break;
    }
    let endpointChild: Parser.SyntaxNode | null = null;
    for (let index = current.childCount - 1; index >= 0; index -= 1) {
      const child = current.child(index);
      if (child !== null && !child.isExtra && child.endPosition.row === current.endPosition.row
        && child.endPosition.column === current.endPosition.column) {
        endpointChild = child;
        break;
      }
    }
    current = endpointChild;
  }
  for (const id of path) { cache.set(id, result); }
  return result;
}

function startsAfterIndentation(node: Parser.SyntaxNode, lines: readonly string[]): boolean {
  const line = lines[node.startPosition.row];
  return line !== undefined && /^[ \t]*$/.test(line.slice(0, node.startPosition.column));
}

function* normalizeCandidates(candidates: FoldingRangeCandidate[], lineCount: number):
Generator<AnalysisStep, FoldingRangeCandidate[], void> {
  const priority = (candidate: FoldingRangeCandidate): number => candidate.kind === 'region' ? 0
    : candidate.kind === 'comment' ? 1 : 2;
  const sorted = candidates.filter(candidate => candidate.startLine >= 0 && candidate.endLine < lineCount
    && candidate.startLine < candidate.endLine).sort((left, right) => left.startLine - right.startLine
      || right.endLine - left.endLine || priority(left) - priority(right));
  yield;

  const normalized: FoldingRangeCandidate[] = [];
  const containing: FoldingRangeCandidate[] = [];
  let previousStart = -1;
  for (let index = 0; index < sorted.length; index += 1) {
    if (index > 0 && index % 256 === 0) { yield; }
    const candidate = sorted[index];
    if (candidate.startLine === previousStart) { continue; }
    previousStart = candidate.startLine;

    while (containing.length > 0 && candidate.startLine > containing[containing.length - 1].endLine) {
      containing.pop();
    }
    if (containing.length > 0 && candidate.endLine > containing[containing.length - 1].endLine) { continue; }
    normalized.push(candidate);
    containing.push(candidate);
  }
  return normalized;
}
