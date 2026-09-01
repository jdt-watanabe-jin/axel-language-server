import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type * as Parser from 'tree-sitter';
import type {
  AnalysisInclude,
  AnalysisIncludeKind,
  AnalysisRange,
  AnalysisScriptExecution
} from '../types/analysis';
import { findNamedNodes, nodeToAnalysisRange } from './syntaxTree';

export interface ResolveIncludeInput {
  includingFilePath: string;
  includeText: string;
  includeRoots: string[];
  fileExists?: (filePath: string) => boolean;
}

export interface ResolvedInclude {
  status: 'resolved';
  includePath: string;
  filePath: string;
  uri: string;
}

export interface UnresolvedInclude {
  status: 'unresolved';
  reason: 'not-found' | 'unsupported';
  includePath: string;
  candidates: string[];
}

export type IncludeResolution = ResolvedInclude | UnresolvedInclude;

interface ParsedIncludeText {
  includePath: string;
  kind: AnalysisIncludeKind;
}

export function resolveInclude(input: ResolveIncludeInput): IncludeResolution {
  const parsed = parseIncludeText(input.includeText);
  if (parsed.kind === 'expression') {
    return {
      status: 'unresolved',
      reason: 'unsupported',
      includePath: parsed.includePath,
      candidates: []
    };
  }

  const candidates = includeCandidates({
    includingFilePath: input.includingFilePath,
    includePath: parsed.includePath,
    kind: parsed.kind,
    includeRoots: input.includeRoots
  });
  const fileExists = input.fileExists ?? fs.existsSync;
  const resolved = candidates.find((candidate) => fileExists(candidate));

  if (resolved === undefined) {
    return {
      status: 'unresolved',
      reason: 'not-found',
      includePath: parsed.includePath,
      candidates
    };
  }

  return {
    status: 'resolved',
    includePath: parsed.includePath,
    filePath: resolved,
    uri: pathToFileURL(resolved).toString()
  };
}

export function resolveScriptExecution(input: Omit<ResolveIncludeInput, 'includeText'> & {
  scriptPath: string;
}): IncludeResolution {
  const candidates = scriptExecutionCandidates({
    includingFilePath: input.includingFilePath,
    scriptPath: input.scriptPath,
    includeRoots: input.includeRoots
  });
  const fileExists = input.fileExists ?? fs.existsSync;
  const resolved = candidates.find((candidate) => fileExists(candidate));

  if (resolved === undefined) {
    return {
      status: 'unresolved',
      reason: 'not-found',
      includePath: input.scriptPath,
      candidates
    };
  }

  return {
    status: 'resolved',
    includePath: input.scriptPath,
    filePath: resolved,
    uri: pathToFileURL(resolved).toString()
  };
}

export function collectIncludes(rootNode: Parser.SyntaxNode): AnalysisInclude[] {
  return findNamedNodes(rootNode, (node) => node.type === 'preproc_include')
    .map((node) => includeFromNode(node))
    .filter((include): include is AnalysisInclude => include !== null);
}

export function collectScriptExecutions(rootNode: Parser.SyntaxNode): AnalysisScriptExecution[] {
  return findNamedNodes(rootNode, (node) => node.type === 'command_statement')
    .map((node) => scriptExecutionFromNode(node))
    .filter((script): script is AnalysisScriptExecution => script !== null);
}

function includeFromNode(node: Parser.SyntaxNode): AnalysisInclude | null {
  const pathNode = node.childForFieldName('path');
  if (pathNode === null) {
    return null;
  }

  const parsed = parseIncludeText(pathNode.text);
  return {
    includePath: parsed.includePath,
    kind: parsed.kind,
    range: nodeToAnalysisRange(pathNode)
  };
}

function scriptExecutionFromNode(node: Parser.SyntaxNode): AnalysisScriptExecution | null {
  const fileNode = node.namedChildren.find((child) => child.type === 'command_identifier');
  if (fileNode === undefined) {
    return null;
  }

  return {
    scriptPath: fileNode.text,
    range: rangeFromPositions(
      { line: node.startPosition.row, character: node.startPosition.column },
      { line: fileNode.endPosition.row, character: fileNode.endPosition.column }
    ),
    selectionRange: nodeToAnalysisRange(fileNode)
  };
}

function includeCandidates(input: {
  includingFilePath: string;
  includePath: string;
  kind: AnalysisIncludeKind;
  includeRoots: string[];
}): string[] {
  const candidates: string[] = [];

  if (input.kind === 'quote') {
    candidates.push(path.normalize(path.join(path.dirname(input.includingFilePath), input.includePath)));
  }

  for (const root of input.includeRoots) {
    candidates.push(path.normalize(path.join(root, input.includePath)));
  }

  return Array.from(new Set(candidates));
}

function scriptExecutionCandidates(input: {
  includingFilePath: string;
  scriptPath: string;
  includeRoots: string[];
}): string[] {
  return includeCandidates({
    includingFilePath: input.includingFilePath,
    includePath: input.scriptPath,
    kind: 'quote',
    includeRoots: input.includeRoots
  }).flatMap((candidate) => scriptPathVariants(candidate));
}

function scriptPathVariants(filePath: string): string[] {
  return path.extname(filePath).length === 0 ? [filePath, `${filePath}.axl`] : [filePath];
}

function parseIncludeText(includeText: string): ParsedIncludeText {
  const trimmed = includeText.trim();
  const withoutWidePrefix = trimmed.startsWith('L"') ? trimmed.slice(1) : trimmed;

  if (withoutWidePrefix.startsWith('"') && withoutWidePrefix.endsWith('"')) {
    return {
      includePath: withoutWidePrefix.slice(1, -1),
      kind: 'quote'
    };
  }

  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return {
      includePath: trimmed.slice(1, -1),
      kind: 'angle'
    };
  }

  if (/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(trimmed)) {
    return {
      includePath: trimmed,
      kind: 'bare'
    };
  }

  return {
    includePath: trimmed,
    kind: 'expression'
  };
}

function rangeFromPositions(start: AnalysisRange['start'], end: AnalysisRange['end']): AnalysisRange {
  return { start, end };
}
