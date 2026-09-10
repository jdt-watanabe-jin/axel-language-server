import type { AnalysisMacroDefinition, AnalysisPosition } from '../types/analysis';
import { resolveSystemMacro } from './systemMacros';
import { message, type MessageDescriptor } from '../i18n/messages';
import type { MacroInvocationCandidate } from './macroInvocation';
import { parseMacroInvocationText } from './macroInvocation';

export interface MacroLookup {
  findMacro(name: string): AnalysisMacroDefinition | undefined;
}

export interface MacroExpansionStep {
  macroName: string;
  before: string;
  after: string;
}

export interface MacroExpansionDiagnostic {
  message: string;
  messageDescriptor?: MessageDescriptor;
}

export interface MacroExpansionResult {
  runtimeMacros?: string[];
  expandedText: string;
  steps: MacroExpansionStep[];
  truncated: boolean;
  diagnostics: MacroExpansionDiagnostic[];
}

interface ExpansionState {
  systemContext?: { uri: string; position: AnalysisPosition; tool?: string };
  runtimeMacros?: Set<string>;
  maxDepth: number;
  depth: number;
  stack: string[];
}

export interface MacroExpansionOptions {
  maxDepth?: number;
  systemContext?: { uri: string; position: AnalysisPosition; tool?: string };
}

export function expandMacroInvocation(
  invocation: MacroInvocationCandidate,
  macro: AnalysisMacroDefinition,
  visibleMacros: MacroLookup,
  options: MacroExpansionOptions = {}
): MacroExpansionResult {
  if (options.systemContext !== undefined) { return expandMacroInvocationText(invocation.rawText, visibleMacros, options); }
  return expandKnownMacro(invocation.rawText, macro, invocation.arguments, visibleMacros, {
    maxDepth: options.maxDepth ?? 8,
    depth: 0,
    stack: []
  });
}

export function expandMacroInvocationText(
  text: string,
  visibleMacros: MacroLookup,
  options: MacroExpansionOptions = {}
): MacroExpansionResult {
  const state: ExpansionState = {
    maxDepth: options.maxDepth ?? 8, depth: 0, stack: [],
    systemContext: options.systemContext, runtimeMacros: new Set()
  };
  const invocation = parseMacroInvocationText(text);
  if (invocation === undefined) {
    return {
      expandedText: text,
      steps: [],
      truncated: false,
      diagnostics: [message('Text is not a macro invocation.')]
    };
  }

  const macro = visibleMacros.findMacro(invocation.name);
  if (macro === undefined) {
    return {
      expandedText: text,
      steps: [],
      truncated: false,
      diagnostics: [message("Macro '{0}' with {1} argument(s) was not found.", invocation.name, invocation.arguments.length)]
    };
  }

  let argumentOffset = text.indexOf('(') + 1;
  // Preserve the original argument boundaries even if an expansion generates commas.
  const args = invocation.arguments.map(argument => {
    if (options.systemContext === undefined) { return argument; }
    const start = text.indexOf(argument, argumentOffset);
    argumentOffset = start + argument.length;
    return expandSourceTokens(argument, visibleMacros, { ...state,
      systemContext: { ...options.systemContext, position: positionWithinText(options.systemContext.position, text, start) }
    });
  });
  return { ...expandKnownMacro(text, macro, args, visibleMacros, state),
    runtimeMacros: [...(state.runtimeMacros ?? [])] };
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
      diagnostics: [message("Macro '{0}' is not function-like.", macro.name)]
    };
  }

  const expected = parameters.length;
  if (expected !== args.length) {
    return {
      expandedText: originalText,
      steps: [],
      truncated: false,
      diagnostics: [message("Macro '{0}' expects {1} argument but got {2}.", macro.name, expected, args.length)]
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
  const substituted = substituteParameters(macro.replacementText, parameterNames, args, state);
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
    const macro = visibleMacros.findMacro(direct.name);
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
    const macro = visibleMacros.findMacro(parsed.name);
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
  args: readonly string[],
  state?: ExpansionState,
  sourcePositions = false,
  sourceExpansions: ReadonlyMap<number, { end: number; text: string }> = new Map()
): string {
  const values = new Map(parameters.map((parameter, index) => [parameter, args[index] ?? '']));
  let result = '';
  let index = 0;

  while (index < replacementText.length) {
    const expansion = sourceExpansions.get(index);
    if (expansion !== undefined) {
      result += expansion.text;
      index = expansion.end;
      continue;
    }
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

    const identifier = /^[A-Za-z_$][0-9A-Za-z_$]*/.exec(replacementText.slice(index));
    if (identifier !== null) {
      let value = values.get(identifier[0]);
      const context = state?.systemContext;
      if (value === undefined && context !== undefined) {
        const position = sourcePositions ? positionWithinText(context.position, replacementText, index) : context.position;
        const macro = resolveSystemMacro(identifier[0], context.uri, position, context.tool);
        if (macro?.defined) {
          if (macro.runtimeFormat !== undefined) { state?.runtimeMacros?.add(macro.name); }
          if (macro.value !== undefined) { value = typeof macro.value === 'number' ? String(macro.value) : JSON.stringify(macro.value); }
        }
      }
      result += value ?? identifier[0];
      index += identifier[0].length;
      continue;
    }

    result += character;
    index += 1;
  }

  return result.replace(/[ \t]*\\\r?\n/g, '\n').trim();
}

function positionWithinText(start: AnalysisPosition, text: string, offset: number): AnalysisPosition {
  const lines = text.slice(0, offset).split('\n');
  return { line: start.line + lines.length - 1,
    character: lines.length === 1 ? start.character + offset : lines[lines.length - 1].length };
}

function expandSourceTokens(text: string, lookup: MacroLookup, state: ExpansionState): string {
  const expansions = new Map<number, { end: number; text: string }>();
  const context = state.systemContext!;
    for (const candidate of findNestedInvocationTexts(text)) {
      const parsed = parseMacroInvocationText(candidate.text);
      if (parsed === undefined || lookup.findMacro(parsed.name) === undefined) { continue; }
      const start = candidate.start;
      const result = expandMacroInvocationText(candidate.text, lookup, {
        maxDepth: state.maxDepth,
        systemContext: { ...context, position: positionWithinText(context.position, text, start) }
      });
      if (result.diagnostics.length > 0 || result.truncated) { continue; }
      for (const name of result.runtimeMacros ?? []) { state.runtimeMacros?.add(name); }
      expansions.set(start, { end: candidate.end, text: result.expandedText });
    }
  // Apply replacements against original offsets; never re-scan generated text as source.
  return substituteParameters(text, [], [], state, true, expansions);
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

    const match = /^[A-Za-z_$][0-9A-Za-z_$]*/.exec(text.slice(index));
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

/** Expand object-like tokens without substituting inside strings or comments. */
export function expandObjectMacroText(text: string, lookup: MacroLookup, stack: readonly string[] = []): MacroExpansionResult {
  let expandedText = '';
  const steps: MacroExpansionStep[] = [];
  let truncated = false;
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === '"' || char === "'" || char === '/' && ['/', '*'].includes(text[i+1])) {
      const end = char !== '/' ? skipQuotedText(text,i,char)
        : text[i+1] === '/' ? skipLineComment(text,i) : skipBlockComment(text,i);
      expandedText += text.slice(i,end); i=end; continue;
    }
    const name = /^[A-Za-z_$][0-9A-Za-z_$]*/.exec(text.slice(i))?.[0];
    if (!name) { expandedText += char; i++; continue; }
    const macro = lookup.findMacro(name);
    if (!macro || macro.parameters !== undefined) { expandedText += name; i += name.length; continue; }
    if (stack.includes(name) || stack.length >= 8) { truncated=true; expandedText+=name; i+=name.length; continue; }
    const nested = expandObjectMacroText(macro.replacementText,lookup,[...stack,name]);
    expandedText += nested.expandedText; truncated ||= nested.truncated;
    steps.push({macroName:name,before:name,after:macro.replacementText},...nested.steps);
    i += name.length;
  }
  return {expandedText,steps,truncated,diagnostics:[]};
}
