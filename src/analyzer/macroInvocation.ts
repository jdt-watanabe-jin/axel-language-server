import type * as Parser from 'tree-sitter';
import type {
  AnalysisDocumentUri,
  AnalysisMacroInvocation,
  AnalysisMacroInvocationContext,
  AnalysisRange
} from '../types/analysis';
import { findNamedNodes, nodeToAnalysisRange } from './syntaxTree';

export type MacroInvocationCandidate = AnalysisMacroInvocation;

export function macroInvocationCandidateFromErrorNode(
  node: Parser.SyntaxNode
): MacroInvocationCandidate | undefined {
  if (node.type !== 'ERROR') {
    return undefined;
  }

  return macroInvocationCandidateFromNode(node);
}

export function macroInvocationCandidateFromNode(
  node: Parser.SyntaxNode
): MacroInvocationCandidate | undefined {
  if (node.type !== 'ERROR' && node.type !== 'call_expression') {
    return undefined;
  }

  const rawText = node.text.trim();
  const parsed = parseMacroInvocationText(rawText);
  if (parsed === undefined) {
    return undefined;
  }

  return {
    ...parsed,
    argumentCount: parsed.arguments.length,
    uri: '',
    range: nodeToAnalysisRange(node),
    selectionRange: selectionRangeForInvocation(node, parsed.name),
    rawText,
    context: contextForNode(node)
  };
}

export function collectMacroInvocations(
  rootNode: Parser.SyntaxNode,
  uri: AnalysisDocumentUri
): AnalysisMacroInvocation[] {
  const invocations = findNamedNodes(
    rootNode,
    (node) => node.type === 'ERROR' || node.type === 'call_expression'
  )
    .flatMap((node) => {
      const candidate = macroInvocationCandidateFromNode(node);
      return candidate === undefined ? [] : [{ ...candidate, uri }];
    });
  return Array.from(new Map(invocations.map((invocation) => [
    `${invocation.range.start.line}:${invocation.range.start.character}:${invocation.range.end.line}:${invocation.range.end.character}`,
    invocation
  ])).values());
}

export function parseMacroInvocationText(text: string): { name: string; arguments: string[] } | undefined {
  const trimmed = text.trim();
  const nameMatch = /^([A-Za-z_]\w*)\s*\(/.exec(trimmed);
  if (nameMatch === null) {
    return undefined;
  }

  const name = nameMatch[1];
  const openParenIndex = trimmed.indexOf('(', nameMatch[0].indexOf('('));
  const closeParenIndex = findMatchingCloseParen(trimmed, openParenIndex);
  if (closeParenIndex !== trimmed.length - 1) {
    return undefined;
  }

  const argumentText = trimmed.slice(openParenIndex + 1, closeParenIndex);
  const macroArguments = splitMacroArguments(argumentText);
  if (macroArguments === undefined) {
    return undefined;
  }
  return { name, arguments: macroArguments };
}

function splitMacroArguments(text: string): string[] | undefined {
  if (text.trim() === '') {
    return [];
  }

  const argumentsList: string[] = [];
  let start = 0;
  const expectedClosers: string[] = [];
  let quote: string | undefined;
  let blockComment = false;
  let lineComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote !== undefined) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '(' || character === '[' || character === '{') {
      expectedClosers.push(matchingCloserFor(character));
      continue;
    }

    if (character === ')' || character === ']' || character === '}') {
      if (expectedClosers.pop() !== character) {
        return undefined;
      }
      continue;
    }

    if (character === ',' && expectedClosers.length === 0) {
      argumentsList.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  if (expectedClosers.length > 0 || quote !== undefined || blockComment) {
    return undefined;
  }

  argumentsList.push(text.slice(start).trim());
  return argumentsList;
}

function findMatchingCloseParen(text: string, openParenIndex: number): number {
  let depth = 0;
  let quote: string | undefined;
  let blockComment = false;
  let lineComment = false;
  for (let index = openParenIndex; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote !== undefined) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function matchingCloserFor(opener: string): string {
  if (opener === '(') {
    return ')';
  }
  if (opener === '[') {
    return ']';
  }
  return '}';
}

function contextForNode(node: Parser.SyntaxNode): AnalysisMacroInvocationContext {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.type === 'field_declaration_list') {
      return 'classBody';
    }
    if (current.type === 'compound_statement') {
      return 'block';
    }
    if (current.type === 'translation_unit') {
      return 'topLevel';
    }
  }
  return 'unknown';
}

function selectionRangeForInvocation(node: Parser.SyntaxNode, name: string): AnalysisRange {
  const range = nodeToAnalysisRange(node);
  return {
    start: range.start,
    end: {
      line: range.start.line,
      character: range.start.character + name.length
    }
  };
}
