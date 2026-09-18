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
  /** Source-written macro names actually expanded, relative to the input text. */
  macroUses?: MacroSourceSpan[];
  /** One origin per expanded UTF-16 unit; generated replacement-body units have no origin. */
  sourceSpans?: (MacroSourceSpan | undefined)[];
  runtimeMacros?: string[];
  expandedText: string;
  steps: MacroExpansionStep[];
  truncated: boolean;
  diagnostics: MacroExpansionDiagnostic[];
}

interface MacroSourceSpan { start: number; end: number }

function copiedSpans(start: number, end: number): MacroSourceSpan[] {
  return Array.from({length:end-start}, (_,i)=>({start:start+i,end:start+i+1}));
}

function composeSpans(spans: (MacroSourceSpan | undefined)[], input: (MacroSourceSpan | undefined)[]): (MacroSourceSpan | undefined)[] {
  return spans.map(span => {
    if (!span) { return undefined; }
    const first = input[span.start], last = input[span.end-1];
    return first && last ? {start:first.start,end:last.end} : undefined;
  });
}

function mapMacroUses(uses: MacroSourceSpan[] | undefined, origins: (MacroSourceSpan | undefined)[] | undefined): MacroSourceSpan[] {
  if (!uses || !origins) { return []; }
  return uses.flatMap(use => {
    const first=origins[use.start],last=origins[use.end-1];
    return first && last ? [{start:first.start,end:last.end}] : [];
  });
}

interface ExpansionState {
  trackSource?: boolean;
  systemContext?: { uri: string; position: AnalysisPosition; tool?: string; targetPlatform?: string; internalFeatures?: string };
  runtimeMacros?: Set<string>;
  maxDepth: number;
  depth: number;
  stack: string[];
}

export interface MacroExpansionOptions {
  trackSource?: boolean;
  maxDepth?: number;
  systemContext?: { uri: string; position: AnalysisPosition; tool?: string; targetPlatform?: string; internalFeatures?: string };
}

export function expandMacroInvocation(
  invocation: MacroInvocationCandidate,
  macro: AnalysisMacroDefinition,
  visibleMacros: MacroLookup,
  options: MacroExpansionOptions = {}
): MacroExpansionResult {
  if (options.systemContext !== undefined) { return expandMacroInvocationText(invocation.rawText, visibleMacros, options); }
  return expandKnownMacro(invocation.rawText, macro, invocation.arguments, visibleMacros, {
    trackSource:options.trackSource,
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
    trackSource:options.trackSource,
    maxDepth: options.maxDepth ?? 8, depth: 0, stack: [],
    systemContext: options.systemContext, runtimeMacros: new Set()
  };
  const name = text.trim();
  const objectMacro = /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(name) ? visibleMacros.findMacro(name) : undefined;
  const invocation = parseMacroInvocationText(text)
    ?? (objectMacro && objectMacro.parameters === undefined ? { name, arguments: [] } : undefined);
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

  return { ...expandKnownMacro(text, macro, invocation.arguments, visibleMacros, state),
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
    const objects = expandObjectMacroText(originalText, visibleMacros, state.stack, state.trackSource);
    if (objects.truncated) { return objects; }
    const nested = expandNestedInvocations(objects.expandedText, visibleMacros, {
      ...state, depth: state.depth + 1, stack: [...state.stack, macro.name]
    });
    return { ...nested, ...(state.trackSource ? {macroUses:[...objects.macroUses ?? [],...mapMacroUses(nested.macroUses,objects.sourceSpans)]} : {}), ...(nested.sourceSpans && objects.sourceSpans
      ? {sourceSpans:composeSpans(nested.sourceSpans,objects.sourceSpans)} : {}), steps: [...objects.steps, ...nested.steps] };
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
  let argumentOffset = originalText.indexOf('(') + 1;
  const argumentStarts = args.map(argument => {
    const start = originalText.indexOf(argument, argumentOffset);
    argumentOffset = start + argument.length;
    return start;
  });
  let argumentTruncated = false;
  const argumentDiagnostics: MacroExpansionDiagnostic[] = [];
  const argumentSpans = new Map<number,(MacroSourceSpan | undefined)[]>();
  const argumentUses: MacroSourceSpan[] = [];
  const substitutedSpans = state.trackSource ? [] as (MacroSourceSpan | undefined)[] : undefined;
  const substituted = substituteParameters(macro.replacementText, parameterNames, args, state, false, undefined,
    (argument, index, pasted) => {
      const context = state.systemContext;
      const expanded = expandSourceTokens(argument, visibleMacros, {...state,
        systemContext: context ? {...context, position: positionWithinText(context.position, originalText, argumentStarts[index])} : undefined
      });
      const objects = expandObjectMacroText(expanded.expandedText, visibleMacros, [], state.trackSource);
      if (state.trackSource && !pasted) {
        argumentUses.push(...[...expanded.macroUses ?? [],...mapMacroUses(objects.macroUses,expanded.sourceSpans)]
          .map(use=>({start:use.start+argumentStarts[index],end:use.end+argumentStarts[index]})));
      }
      argumentTruncated ||= expanded.truncated || objects.truncated;
      argumentDiagnostics.push(...expanded.diagnostics, ...objects.diagnostics);
      if (objects.sourceSpans && expanded.sourceSpans) {
        argumentSpans.set(index,composeSpans(objects.sourceSpans,expanded.sourceSpans)
          .map(span=>span && ({start:span.start+argumentStarts[index],end:span.end+argumentStarts[index]})));
      }
      return objects.expandedText;
    },substitutedSpans,argumentSpans);
  if (argumentTruncated || argumentDiagnostics.length > 0) {
    return {expandedText: originalText, steps: [], truncated: argumentTruncated, diagnostics: argumentDiagnostics};
  }
  const nested = expandNestedInvocations(substituted, visibleMacros, {
    ...state,
    depth: state.depth + 1,
    stack: [...state.stack, macro.name]
  });

  return {
    ...(state.trackSource ? {macroUses:[{start:0,end:macro.name.length},...argumentUses,...mapMacroUses(nested.macroUses,substitutedSpans)]} : {}),
    ...(nested.sourceSpans && substitutedSpans ? {sourceSpans:composeSpans(nested.sourceSpans,substitutedSpans)} : {}),
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
  const macroUses: MacroSourceSpan[] = [];
  let sourceSpans: (MacroSourceSpan | undefined)[] | undefined = state.trackSource ? copiedSpans(0,text.length) : undefined;
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
    macroUses.push(...(result.macroUses ?? []).map(use=>({start:use.start+invocation.start,end:use.end+invocation.start})));
    if (sourceSpans) {
      const replacement = result.sourceSpans?.map(span=>span && ({start:span.start+invocation.start,end:span.end+invocation.start}))
        ?? Array.from({length:result.expandedText.length},()=>undefined);
      sourceSpans.splice(invocation.start,invocation.end-invocation.start,...replacement);
    }
    expandedText = expandedText.slice(0, invocation.start) + result.expandedText + expandedText.slice(invocation.end);
    steps.push(...result.steps);
    diagnostics.push(...result.diagnostics);
    truncated ||= result.truncated;
  }

  if (sourceSpans) { sourceSpans = sourceSpans.slice(expandedText.length-expandedText.trimStart().length,expandedText.trimEnd().length); }
  return { expandedText: expandedText.trim(), ...(sourceSpans ? {sourceSpans,macroUses} : {}), steps, truncated, diagnostics };
}

function substituteParameters(
  replacementText: string,
  parameters: readonly string[],
  args: readonly string[],
  state?: ExpansionState,
  sourcePositions = false,
  sourceExpansions: ReadonlyMap<number, { end: number; text: string; spans?: (MacroSourceSpan | undefined)[] }> = new Map(),
  expandArgument?: (argument: string, index: number, pasted: boolean) => string,
  sourceSpans?: (MacroSourceSpan | undefined)[],
  argumentSpans?: ReadonlyMap<number,(MacroSourceSpan | undefined)[]>
): string {
  const rawValues = new Map(parameters.map((parameter, index) => [parameter, args[index] ?? '']));
  const values = new Map<string, string>();
  let result = '';
  let index = 0;
  const append = (text: string, spans?: (MacroSourceSpan | undefined)[]) => {
    result += text;
    if (sourceSpans) { sourceSpans.push(...spans ?? Array.from({length:text.length},()=>undefined)); }
  };

  while (index < replacementText.length) {
    const expansion = sourceExpansions.get(index);
    if (expansion !== undefined) {
      append(expansion.text,expansion.spans);
      index = expansion.end;
      continue;
    }
    const character = replacementText[index];
    const next = replacementText[index + 1];

    if (character === '"' || character === "'") {
      const end = skipQuotedText(replacementText, index, character);
      append(replacementText.slice(index,end),sourceSpans && sourcePositions ? copiedSpans(index,end) : undefined);
      index = end;
      continue;
    }

    if (character === '/' && next === '/') {
      const end = skipLineComment(replacementText, index);
      append(replacementText.slice(index,end),sourceSpans && sourcePositions ? copiedSpans(index,end) : undefined);
      index = end;
      continue;
    }

    if (character === '/' && next === '*') {
      const end = skipBlockComment(replacementText, index);
      append(replacementText.slice(index,end),sourceSpans && sourcePositions ? copiedSpans(index,end) : undefined);
      index = end;
      continue;
    }

    if (character === '#' && next !== '#' && replacementText[index - 1] !== '#') {
      const operandStart = skipMacroTrivia(replacementText, index + 1);
      const operand = /^[A-Za-z_$][0-9A-Za-z_$]*/.exec(replacementText.slice(operandStart));
      if (operand && rawValues.has(operand[0])) {
        append(stringifyMacroArgument(rawValues.get(operand[0])!));
        index = operandStart + operand[0].length;
        continue;
      }
    }

    const identifier = /^[A-Za-z_$][0-9A-Za-z_$]*/.exec(replacementText.slice(index));
    if (identifier !== null) {
      const pasted = replacementText.slice(0,index).replace(/\/\*[\s\S]*?\*\//g,'').trimEnd().endsWith('##')
        || replacementText.startsWith('##',skipMacroTrivia(replacementText,index+identifier[0].length));
      let value = pasted ? undefined : values.get(identifier[0]);
      if (value === undefined && rawValues.has(identifier[0])) {
        const raw = rawValues.get(identifier[0])!;
        value = expandArgument?.(raw, parameters.indexOf(identifier[0]),pasted) ?? raw;
        if (!pasted) { values.set(identifier[0], value); }
      }
      const context = state?.systemContext;
      if (value === undefined && context !== undefined) {
        const position = sourcePositions ? positionWithinText(context.position, replacementText, index) : context.position;
        const macro = resolveSystemMacro(identifier[0], context.uri, position, context.tool, context.targetPlatform, context.internalFeatures);
        if (macro?.defined) {
          if (macro.runtimeFormat !== undefined) { state?.runtimeMacros?.add(macro.name); }
          if (macro.value !== undefined) { value = typeof macro.value === 'number' ? String(macro.value) : JSON.stringify(macro.value); }
        }
      }
      const replacement = value ?? identifier[0];
      append(replacement,pasted ? undefined : argumentSpans?.get(parameters.indexOf(identifier[0]))
        ?? (sourceSpans && sourcePositions ? value === undefined ? copiedSpans(index,index+identifier[0].length)
          : Array.from({length:replacement.length},()=>({start:index,end:index+identifier[0].length})) : undefined));
      index += identifier[0].length;
      continue;
    }

    append(character,sourceSpans && sourcePositions ? [{start:index,end:index+1}] : undefined);
    index += 1;
  }

  if (sourceSpans) {
    for (const match of [...result.matchAll(/[ \t]*\\\r?\n/g)].reverse()) {
      sourceSpans.splice(match.index!,match[0].length-1);
    }
    const normalized = result.replace(/[ \t]*\\\r?\n/g,'\n');
    sourceSpans.splice(normalized.trimEnd().length);
    sourceSpans.splice(0,normalized.length-normalized.trimStart().length);
  }
  return result.replace(/[ \t]*\\\r?\n/g, '\n').trim();
}

function skipMacroTrivia(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (text.startsWith('\\\r\n', index)) { index += 3; }
    else if (text.startsWith('\\\n', index)) { index += 2; }
    else if (/\s/.test(text[index])) { index++; }
    else if (text.startsWith('/*', index)) { index = skipBlockComment(text, index); }
    else if (text.startsWith('//', index)) { index = skipLineComment(text, index); }
    else { break; }
  }
  return index;
}

/** Stringification uses written tokens, with comments/whitespace collapsed outside literals. */
function stringifyMacroArgument(argument: string): string {
  const text = argument.replace(/\\\r?\n/g, '');
  let result = '';
  for (let index = 0; index < text.length;) {
    const afterTrivia = skipMacroTrivia(text, index);
    if (afterTrivia !== index) {
      if (result && afterTrivia < text.length) { result += ' '; }
      index = afterTrivia;
    } else if (text[index] === '"' || text[index] === "'") {
      const end = skipQuotedText(text, index, text[index]);
      result += text.slice(index, end);
      index = end;
    } else { result += text[index++]; }
  }
  return JSON.stringify(result);
}

function positionWithinText(start: AnalysisPosition, text: string, offset: number): AnalysisPosition {
  const lines = text.slice(0, offset).split('\n');
  return { line: start.line + lines.length - 1,
    character: lines.length === 1 ? start.character + offset : lines[lines.length - 1].length };
}

function expandSourceTokens(text: string, lookup: MacroLookup, state: ExpansionState): MacroExpansionResult {
  const macroUses: MacroSourceSpan[] = [];
  let truncated = false;
  const diagnostics: MacroExpansionDiagnostic[] = [];
  const expansions = new Map<number, { end: number; text: string; spans?: (MacroSourceSpan | undefined)[] }>();
  const sourceSpans = state.trackSource ? [] as (MacroSourceSpan | undefined)[] : undefined;
  const context = state.systemContext;
    for (const candidate of findNestedInvocationTexts(text)) {
      const parsed = parseMacroInvocationText(candidate.text);
      const macro = parsed && lookup.findMacro(parsed.name);
      if (!parsed || !macro) { continue; }
      const start = candidate.start;
      const result = expandKnownMacro(candidate.text, macro, parsed.arguments, lookup, {
        ...state, depth: state.depth + 1,
        systemContext: context ? { ...context, position: positionWithinText(context.position, text, start) } : undefined
      });
      truncated ||= result.truncated;
      diagnostics.push(...result.diagnostics);
      if (result.diagnostics.length > 0 || result.truncated) { continue; }
      macroUses.push(...(result.macroUses ?? []).map(use=>({start:use.start+start,end:use.end+start})));
      for (const name of result.runtimeMacros ?? []) { state.runtimeMacros?.add(name); }
      expansions.set(start, { end: candidate.end, text: result.expandedText,
        spans:result.sourceSpans?.map(span=>span && ({start:span.start+start,end:span.end+start})) });
    }
  // Apply replacements against original offsets; never re-scan generated text as source.
  return {expandedText: substituteParameters(text, [], [], state, true, expansions,undefined,sourceSpans),
    ...(sourceSpans ? {sourceSpans,macroUses} : {}),steps: [], truncated, diagnostics};
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

function numericTokenEnd(text: string, start: number): number {
  if (!/[0-9]/.test(text[start] ?? '') && !(text[start] === '.' && /[0-9]/.test(text[start+1] ?? ''))) { return start; }
  let index=start+1;
  while (index<text.length && (/[A-Za-z0-9_$.]/.test(text[index])
    || /[+-]/.test(text[index]) && /[eEpP]/.test(text[index-1]))) { index++; }
  return index;
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
export function expandObjectMacroText(text: string, lookup: MacroLookup, stack: readonly string[] = [], trackSource = false): MacroExpansionResult {
  const macroUses: MacroSourceSpan[] = [];
  let expandedText = '';
  const sourceSpans = trackSource ? [] as (MacroSourceSpan | undefined)[] : undefined;
  const copy = (start:number,end:number) => {
    expandedText += text.slice(start,end);
    sourceSpans?.push(...copiedSpans(start,end));
  };
  const steps: MacroExpansionStep[] = [];
  let truncated = false;
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === '"' || char === "'" || char === '/' && ['/', '*'].includes(text[i+1])) {
      const end = char !== '/' ? skipQuotedText(text,i,char)
        : text[i+1] === '/' ? skipLineComment(text,i) : skipBlockComment(text,i);
      copy(i,end); i=end; continue;
    }
    const numericEnd = numericTokenEnd(text,i);
    if (numericEnd>i) { copy(i,numericEnd); i=numericEnd; continue; }
    const name = /^[A-Za-z_$][0-9A-Za-z_$]*/.exec(text.slice(i))?.[0];
    if (!name) { copy(i,i+1); i++; continue; }
    const macro = lookup.findMacro(name);
    if (!macro || macro.parameters !== undefined) { copy(i,i+name.length); i += name.length; continue; }
    if (stack.includes(name) || stack.length >= 8) { truncated=true; copy(i,i+name.length); i+=name.length; continue; }
    const nested = expandObjectMacroText(macro.replacementText,lookup,[...stack,name]);
    if (trackSource) { macroUses.push({start:i,end:i+name.length}); }
    expandedText += nested.expandedText; truncated ||= nested.truncated;
    sourceSpans?.push(...Array.from({length:nested.expandedText.length},()=>({start:i,end:i+name.length})));
    steps.push({macroName:name,before:name,after:macro.replacementText},...nested.steps);
    i += name.length;
  }
  return {expandedText,...(sourceSpans ? {sourceSpans,macroUses} : {}),steps,truncated,diagnostics:[]};
}

export interface MacroSourceReplacement {
  macroUses?: MacroSourceSpan[];
  sourceSpans?: (MacroSourceSpan | undefined)[];
  start: number;
  end: number;
  name: string;
  text: string;
}

/** Lex macro tokens only; AXEL syntax is always parsed by Tree-sitter after expansion. */
export function collectMacroSourceReplacements(text: string,
  lookupAt: (offset: number) => MacroLookup | undefined): MacroSourceReplacement[] {
  const result: MacroSourceReplacement[] = [];
  for (let index = 0; index < text.length;) {
    const c = text[index];
    if (c === '"' || c === "'" || c === '/' && ['/', '*'].includes(text[index + 1])) {
      index = c !== '/' ? skipQuotedText(text, index, c)
        : text[index + 1] === '/' ? skipLineComment(text, index) : skipBlockComment(text, index);
      continue;
    }
    // Directive bodies are definitions/conditions, not runtime macro uses.
    if (c === '#' && text.slice(text.lastIndexOf('\n', index - 1) + 1, index).trim() === '') {
      do {
        const end = text.indexOf('\n', index);
        if (end < 0) { index = text.length; break; }
        const continued = text.slice(index, end).trimEnd().endsWith('\\');
        index = end + 1;
        if (!continued) { break; }
      } while (index < text.length);
      continue;
    }
    if (/[0-9]/.test(c) || c === '.' && /[0-9]/.test(text[index+1] ?? '')) {
      index++;
      while (index<text.length && (/[A-Za-z0-9_$.]/.test(text[index])
        || /[+-]/.test(text[index]) && /[eEpP]/.test(text[index-1]))) { index++; }
      continue;
    }
    const name = /^[A-Za-z_$][0-9A-Za-z_$]*/.exec(text.slice(index))?.[0];
    if (!name) { index++; continue; }
    const start = index;
    index += name.length;
    const lookup = lookupAt(start);
    const macro = lookup?.findMacro(name);
    if (!lookup || !macro) { continue; }
    let expansion: MacroExpansionResult;
    if (macro.parameters !== undefined) {
      const open = skipWhitespace(text, index);
      if (text[open] !== '(') { continue; }
      const close = findMatchingCloseParen(text, open);
      if (close < 0) { continue; }
      index = close + 1;
      expansion = expandMacroInvocationText(text.slice(start, index), lookup,{trackSource:true});
    } else {
      expansion = expandObjectMacroText(name, lookup,[],true);
      const alias = lookup.findMacro(expansion.expandedText.trim());
      const open = skipWhitespace(text,index);
      if (alias?.parameters !== undefined && text[open] === '(') {
        const close=findMatchingCloseParen(text,open);
        if (close>=0) {
          const aliasSpans = [...expansion.sourceSpans!,...copiedSpans(open-start,close+1-start)];
          expansion=expandMacroInvocationText(expansion.expandedText+text.slice(open,close+1),lookup,{trackSource:true});
          expansion.macroUses=mapMacroUses(expansion.macroUses,aliasSpans);
          if (expansion.sourceSpans) { expansion.sourceSpans=composeSpans(expansion.sourceSpans,aliasSpans); }
          index=close+1;
        }
      }
    }
    if (expansion.truncated || expansion.diagnostics.length) { continue; }
    // Expand object tokens introduced by function macros, and vice versa.
    let expanded = expansion.expandedText;
    let sourceSpans = expansion.sourceSpans;
    const macroUses = [...expansion.macroUses ?? []];
    let complete = true;
    for (let depth = 0; depth < 8; depth++) {
      const objects = expandObjectMacroText(expanded, lookup,[],true);
      const calls = expandNestedInvocations(objects.expandedText, lookup, {maxDepth:8,depth,stack:[],trackSource:true});
      if (objects.truncated || calls.truncated || calls.diagnostics.length) { complete = false; break; }
      macroUses.push(...mapMacroUses(objects.macroUses,sourceSpans),
        ...mapMacroUses(mapMacroUses(calls.macroUses,objects.sourceSpans),sourceSpans));
      if (calls.expandedText === expanded) { break; }
      if (sourceSpans && objects.sourceSpans && calls.sourceSpans) {
        sourceSpans=composeSpans(composeSpans(calls.sourceSpans,objects.sourceSpans),sourceSpans);
      }
      expanded = calls.expandedText;
      if (depth === 7) { complete = false; }
    }
    if (complete) { result.push({start, end:index, name, text:expanded,sourceSpans,macroUses}); }
  }
  return result;
}
