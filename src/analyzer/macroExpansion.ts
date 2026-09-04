import type { AnalysisMacroDefinition } from '../types/analysis';
import type { MacroInvocationCandidate } from './macroInvocation';
import { parseMacroInvocationText } from './macroInvocation';

export interface MacroLookup {
  findMacro(name: string, arity?: number): AnalysisMacroDefinition | undefined;
}

export interface MacroExpansionStep {
  macroName: string;
  before: string;
  after: string;
}

export interface MacroExpansionDiagnostic {
  message: string;
}

export interface MacroExpansionResult {
  expandedText: string;
  steps: MacroExpansionStep[];
  truncated: boolean;
  diagnostics: MacroExpansionDiagnostic[];
}

interface ExpansionState {
  maxDepth: number;
  depth: number;
  stack: string[];
}

export function expandMacroInvocation(
  invocation: MacroInvocationCandidate,
  macro: AnalysisMacroDefinition,
  visibleMacros: MacroLookup,
  options: { maxDepth?: number } = {}
): MacroExpansionResult {
  return expandKnownMacro(invocation.rawText, macro, invocation.arguments, visibleMacros, {
    maxDepth: options.maxDepth ?? 8,
    depth: 0,
    stack: []
  });
}

export function expandMacroInvocationText(
  text: string,
  visibleMacros: MacroLookup,
  options: { maxDepth?: number } = {}
): MacroExpansionResult {
  const invocation = parseMacroInvocationText(text);
  if (invocation === undefined) {
    return {
      expandedText: text,
      steps: [],
      truncated: false,
      diagnostics: [{ message: 'Text is not a macro invocation.' }]
    };
  }

  const macro = findMacroAllowingArityDiagnostic(visibleMacros, invocation.name, invocation.arguments.length);
  if (macro === undefined) {
    return {
      expandedText: text,
      steps: [],
      truncated: false,
      diagnostics: [{ message: `Macro '${invocation.name}' with ${invocation.arguments.length} argument(s) was not found.` }]
    };
  }

  return expandKnownMacro(text, macro, invocation.arguments, visibleMacros, {
    maxDepth: options.maxDepth ?? 8,
    depth: 0,
    stack: []
  });
}

function expandKnownMacro(
  originalText: string,
  macro: AnalysisMacroDefinition,
  args: readonly string[],
  visibleMacros: MacroLookup,
  state: ExpansionState
): MacroExpansionResult {
  const parameters = macro.parameters;
  if (parameters === undefined) {
    return {
      expandedText: originalText,
      steps: [],
      truncated: false,
      diagnostics: [{ message: `Macro '${macro.name}' is not function-like.` }]
    };
  }

  const expected = parameters.length;
  if (expected !== args.length) {
    return {
      expandedText: originalText,
      steps: [],
      truncated: false,
      diagnostics: [{ message: `Macro '${macro.name}' expects ${expected} argument but got ${args.length}.` }]
    };
  }

  if (state.depth >= state.maxDepth || state.stack.includes(macro.name)) {
    return {
      expandedText: originalText,
      steps: [],
      truncated: true,
      diagnostics: []
    };
  }

  const parameterNames = parameters.map((parameter) => parameter.label);
  const substituted = substituteParameters(macro.replacementText, parameterNames, args);
  const nested = expandNestedInvocations(substituted, visibleMacros, {
    ...state,
    depth: state.depth + 1,
    stack: [...state.stack, macro.name]
  });

  return {
    expandedText: nested.expandedText,
    steps: [
      { macroName: macro.name, before: originalText, after: substituted },
      ...nested.steps
    ],
    truncated: nested.truncated,
    diagnostics: nested.diagnostics
  };
}

function expandNestedInvocations(
  text: string,
  visibleMacros: MacroLookup,
  state: ExpansionState
): MacroExpansionResult {
  const direct = parseMacroInvocationText(text);
  if (direct !== undefined) {
    const macro = findMacroAllowingArityDiagnostic(visibleMacros, direct.name, direct.arguments.length);
    if (macro !== undefined) {
      return expandKnownMacro(text, macro, direct.arguments, visibleMacros, state);
    }
  }

  let expandedText = text;
  const steps: MacroExpansionStep[] = [];
  const diagnostics: MacroExpansionDiagnostic[] = [];
  let truncated = false;

  for (const invocation of findNestedInvocationTexts(expandedText)) {
    const parsed = parseMacroInvocationText(invocation.text);
    if (parsed === undefined) {
      continue;
    }
    const macro = findMacroAllowingArityDiagnostic(visibleMacros, parsed.name, parsed.arguments.length);
    if (macro === undefined) {
      continue;
    }
    const result = expandKnownMacro(invocation.text, macro, parsed.arguments, visibleMacros, state);
    expandedText = expandedText.slice(0, invocation.start) + result.expandedText + expandedText.slice(invocation.end);
    steps.push(...result.steps);
    diagnostics.push(...result.diagnostics);
    truncated ||= result.truncated;
  }

  return { expandedText: expandedText.trim(), steps, truncated, diagnostics };
}

function substituteParameters(
  replacementText: string,
  parameters: readonly string[],
  args: readonly string[]
): string {
  const values = new Map(parameters.map((parameter, index) => [parameter, args[index] ?? '']));
  let result = '';
  let index = 0;

  while (index < replacementText.length) {
    const character = replacementText[index];
    const next = replacementText[index + 1];

    if (character === '"' || character === "'") {
      const end = skipQuotedText(replacementText, index, character);
      result += replacementText.slice(index, end);
      index = end;
      continue;
    }

    if (character === '/' && next === '/') {
      const end = skipLineComment(replacementText, index);
      result += replacementText.slice(index, end);
      index = end;
      continue;
    }

    if (character === '/' && next === '*') {
      const end = skipBlockComment(replacementText, index);
      result += replacementText.slice(index, end);
      index = end;
      continue;
    }

    const identifier = /^[A-Za-z_]\w*/.exec(replacementText.slice(index));
    if (identifier !== null) {
      result += values.get(identifier[0]) ?? identifier[0];
      index += identifier[0].length;
      continue;
    }

    result += character;
    index += 1;
  }

  return result.replace(/[ \t]*\\\r?\n/g, '\n').trim();
}

function findNestedInvocationTexts(text: string): { text: string; start: number; end: number }[] {
  const results: { text: string; start: number; end: number }[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"' || character === "'") {
      index = skipQuotedText(text, index, character);
      continue;
    }
    if (character === '/' && next === '/') {
      index = skipLineComment(text, index);
      continue;
    }
    if (character === '/' && next === '*') {
      index = skipBlockComment(text, index);
      continue;
    }

    const match = /^[A-Za-z_]\w*/.exec(text.slice(index));
    if (match === null) {
      index += 1;
      continue;
    }

    const nameEnd = index + match[0].length;
    const open = skipWhitespace(text, nameEnd);
    if (text[open] !== '(') {
      index = nameEnd;
      continue;
    }

    const close = findMatchingCloseParen(text, open);
    if (close > open) {
      results.push({ text: text.slice(index, close + 1), start: index, end: close + 1 });
      index = close + 1;
      continue;
    }

    index = nameEnd;
  }
  return results.reverse();
}

function findMacroAllowingArityDiagnostic(
  visibleMacros: MacroLookup,
  name: string,
  arity: number
): AnalysisMacroDefinition | undefined {
  return visibleMacros.findMacro(name, arity) ?? visibleMacros.findMacro(name);
}

function skipQuotedText(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function skipLineComment(text: string, start: number): number {
  const end = text.slice(start).search(/\r?\n/);
  return end < 0 ? text.length : start + end;
}

function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2);
  return end < 0 ? text.length : end + 2;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  return index;
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
