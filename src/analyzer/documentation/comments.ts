import type * as Parser from 'tree-sitter';
import type { AnalysisPosition } from '../../types/analysis';
import type { DocSource } from './model';

export interface ExtractedComment {
  source: DocSource;
  lines: { text: string; source: DocSource }[];
  placement: 'leading' | 'trailing';
}

interface ClassifiedComment {
  node: Parser.SyntaxNode;
  marker: string;
  kind: 'block' | 'line';
  placement: 'leading' | 'trailing';
}

interface PhysicalLine {
  raw: string;
  content: string;
  start: number;
  end: number;
}

interface SourceLocator {
  text: string;
  uri: string;
  lineStarts: number[];
}

export function extractDocumentationComments(
  root: Parser.SyntaxNode,
  text: string,
  uri: string
): ExtractedComment[] {
  const locator = createSourceLocator(text, uri);
  const comments = root.descendantsOfType('comment')
    .map(classifyComment)
    .filter((comment): comment is ClassifiedComment => comment !== undefined)
    .sort((left, right) => left.node.startIndex - right.node.startIndex);
  const extracted: ExtractedComment[] = [];

  for (let index = 0; index < comments.length;) {
    const first = comments[index];
    if (first.kind === 'block') {
      extracted.push(extractBlockComment(first, locator));
      index += 1;
      continue;
    }

    const group = [first];
    index += 1;
    while (index < comments.length && canGroupLineComments(group.at(-1)!, comments[index], text)) {
      group.push(comments[index]);
      index += 1;
    }
    extracted.push(extractLineComments(group, locator));
  }

  return extracted;
}

function classifyComment(node: Parser.SyntaxNode): ClassifiedComment | undefined {
  const raw = node.text;
  for (const marker of ['/**<', '/*!<'] as const) {
    if (raw.startsWith(marker)) {
      return { node, marker, kind: 'block', placement: 'trailing' };
    }
  }
  if (raw.startsWith('/**') && !raw.startsWith('/***')) {
    return { node, marker: '/**', kind: 'block', placement: 'leading' };
  }
  if (raw.startsWith('/*!')) {
    return { node, marker: '/*!', kind: 'block', placement: 'leading' };
  }
  for (const marker of ['///<', '//!<'] as const) {
    if (raw.startsWith(marker)) {
      return { node, marker, kind: 'line', placement: 'trailing' };
    }
  }
  if (raw.startsWith('///')) {
    return { node, marker: '///', kind: 'line', placement: 'leading' };
  }
  if (raw.startsWith('//!')) {
    return { node, marker: '//!', kind: 'line', placement: 'leading' };
  }
  return undefined;
}

function canGroupLineComments(
  left: ClassifiedComment,
  right: ClassifiedComment,
  text: string
): boolean {
  return right.kind === 'line'
    && left.placement === right.placement
    && /^(?:\r\n|\n|\r)[ \t]*$/.test(text.slice(left.node.endIndex, right.node.startIndex));
}

function extractLineComments(
  comments: readonly ClassifiedComment[],
  locator: SourceLocator
): ExtractedComment {
  const first = comments[0];
  const last = comments.at(-1)!;
  const lines = comments.map(comment => {
    const raw = comment.node.text;
    const body = raw.slice(comment.marker.length).replace(/^[ \t]?/, '');
    return {
      text: body,
      source: sourceFromNode(comment.node, locator)
    };
  });
  return {
    source: sourceFromOffsets(locator, first.node.startIndex, last.node.endIndex),
    lines,
    placement: first.placement
  };
}

function extractBlockComment(
  comment: ClassifiedComment,
  locator: SourceLocator
): ExtractedComment {
  const start = comment.node.startIndex;
  const raw = comment.node.text;
  const physical = splitPhysicalLines(raw, start);
  physical[0].content = physical[0].content.slice(comment.marker.length);
  if (raw.endsWith('*/')) {
    const last = physical.at(-1)!;
    last.content = last.content.slice(0, last.content.lastIndexOf('*/')).replace(/[ \t]+$/, '');
  }

  while (physical.length > 0 && physical[0].content.trim().length === 0) {
    physical.shift();
  }
  while (physical.length > 0 && physical.at(-1)!.content.trim().length === 0) {
    physical.pop();
  }

  const indentation = commonIndentation(physical.map(line => line.content));
  const lines = physical.map(line => ({
    text: removeDecoration(line.content.slice(indentation)),
    source: sourceFromCodeUnitOffsets(locator, line.start, line.end, line.raw)
  }));
  return {
    source: sourceFromNode(comment.node, locator),
    lines,
    placement: comment.placement
  };
}

function splitPhysicalLines(raw: string, start: number): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let offset = 0;
  for (const match of raw.matchAll(/\r\n|\n|\r/g)) {
    const end = match.index;
    const value = raw.slice(offset, end);
    lines.push({ raw: value, content: value, start: start + offset, end: start + end });
    offset = end + match[0].length;
  }
  const value = raw.slice(offset);
  lines.push({ raw: value, content: value, start: start + offset, end: start + raw.length });
  return lines;
}

function commonIndentation(lines: readonly string[]): number {
  const indents = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.match(/^[ \t]*/)![0].length);
  return indents.length === 0 ? 0 : Math.min(...indents);
}

function removeDecoration(line: string): string {
  return line.replace(/^\*[ \t]?/, '');
}

function createSourceLocator(text: string, uri: string): SourceLocator {
  const lineStarts = [0];
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    lineStarts.push(match.index + match[0].length);
  }
  return { text, uri, lineStarts };
}

function sourceFromNode(node: Parser.SyntaxNode, locator: SourceLocator): DocSource {
  return sourceFromOffsets(locator, node.startIndex, node.endIndex);
}

function sourceFromOffsets(locator: SourceLocator, start: number, end: number): DocSource {
  return sourceFromCodeUnitOffsets(locator, start, end, locator.text.slice(start, end));
}

function sourceFromCodeUnitOffsets(
  locator: SourceLocator,
  start: number,
  end: number,
  raw: string
): DocSource {
  return {
    uri: locator.uri,
    range: { start: positionAt(locator, start), end: positionAt(locator, end) },
    raw
  };
}

function positionAt(locator: SourceLocator, offset: number): AnalysisPosition {
  let low = 0;
  let high = locator.lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (locator.lineStarts[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const line = Math.max(0, low - 1);
  return { line, character: offset - locator.lineStarts[line] };
}
