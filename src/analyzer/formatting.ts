import { runAnalysisSteps, type AnalysisStep } from '../util/analysisSteps';
import { createAxelParser } from './axelParser';
import type { AnalysisFormattingOptions, AnalysisPosition, AnalysisRange, AnalysisTextEdit } from '../types/analysis';

export interface FormattingInput {
  text: string;
  options: AnalysisFormattingOptions;
  range?: AnalysisRange;
}

interface LineBraceState {
  opens: number;
  closes: number;
  inBlockComment: boolean;
  unterminatedLiteral: boolean;
  continuationDelta: number;
  unsupportedToken: boolean;
  preprocessorDirective: string | undefined;
}

export function getFormattingEdits(input: FormattingInput): AnalysisTextEdit[] {
  return runAnalysisSteps(getFormattingEditsSteps(input));
}

export function* getFormattingEditsSteps(input: FormattingInput): Generator<AnalysisStep, AnalysisTextEdit[], void> {
  yield;
  if (input.text.length === 0 || hasSyntaxErrors(input.text)) {
    return [];
  }

  const lines = input.text.split(/\r\n|\n|\r/);
  const target = targetLineRange(input.range, lines.length);
  const edits: AnalysisTextEdit[] = [];
  let indentLevel = 0;
  let inBlockComment = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (lineIndex % 128 === 0) { yield; }
    const line = lines[lineIndex] ?? '';
    const trimmed = line.trimStart();

    if (lineIndex >= target.startLine && lineIndex <= target.endLine && trimmed.length > 0) {
      const existingIndentLength = line.length - trimmed.length;
      const expectedIndent = lineIndentation(indentLevel, trimmed, input.options);
      const existingIndent = line.slice(0, existingIndentLength);

      if (existingIndent !== expectedIndent) {
        edits.push({
          range: {
            start: { line: lineIndex, character: 0 },
            end: { line: lineIndex, character: existingIndentLength }
          },
          newText: expectedIndent
        });
      }
    }

    const braceState = countStructuralBraces(line, inBlockComment);
    inBlockComment = braceState.inBlockComment;
    indentLevel = Math.max(0, indentLevel + braceState.opens - braceState.closes);
  }

  if (inBlockComment || indentLevel !== 0) {
    return [];
  }

  return edits;
}

function hasSyntaxErrors(text: string): boolean {
  return createAxelParser().parse(text).rootNode.hasError;
}

function targetLineRange(range: AnalysisRange | undefined, lineCount: number): { startLine: number; endLine: number } {
  if (range === undefined) {
    return { startLine: 0, endLine: lineCount - 1 };
  }

  const endLine = range.end.character === 0 ? range.end.line - 1 : range.end.line;
  return {
    startLine: Math.max(0, range.start.line),
    endLine: Math.min(lineCount - 1, Math.max(range.start.line, endLine))
  };
}

function countStructuralBraces(line: string, inBlockComment: boolean): LineBraceState {
  let opens = 0;
  let closes = 0;
  let inString = false;
  let inCharacter = false;
  let escaped = false;
  let continuationDelta = 0;
  let unsupportedToken = false;
  let hasCodeToken = false;
  let preprocessorDirective: string | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];

    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString || inCharacter) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === '\\') {
        escaped = true;
        continue;
      }

      if ((inString && character === '"') || (inCharacter && character === "'")) {
        inString = false;
        inCharacter = false;
      }
      continue;
    }

    if (character === '/' && next === '/') {
      break;
    }

    if (character === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (!hasCodeToken && character !== undefined && !/\s/.test(character)) {
      hasCodeToken = true;
      if (character === '#') { preprocessorDirective = ''; }
    } else if (preprocessorDirective === '' && character !== undefined && /[A-Za-z_]/.test(character)) {
      preprocessorDirective = /^[A-Za-z_]+/.exec(line.slice(index))?.[0];
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "'") {
      inCharacter = true;
      continue;
    }

    if (character === '(' || character === '[') { continuationDelta += 1; }
    if (character === ')' || character === ']') { continuationDelta -= 1; }
    if (character === '`') { unsupportedToken = true; }

    if (character === '{') {
      opens += 1;
    } else if (character === '}') {
      closes += 1;
    }
  }

  return { opens, closes, inBlockComment, unterminatedLiteral: inString || inCharacter, continuationDelta, unsupportedToken, preprocessorDirective };
}


export interface OnTypeFormattingInput {
  text: string;
  options: AnalysisFormattingOptions;
  position: AnalysisPosition;
  ch: string;
}

export function getOnTypeFormattingEdits(input: OnTypeFormattingInput): AnalysisTextEdit[] {
  return runAnalysisSteps(getOnTypeFormattingEditsSteps(input));
}

export function* getOnTypeFormattingEditsSteps(input: OnTypeFormattingInput): Generator<AnalysisStep, AnalysisTextEdit[], void> {
  yield;
  if (input.ch !== '}' && input.ch !== '\n') { return []; }
  const lines = input.text.split(/\r\n|\n|\r/);
  const { line: lineIndex, character } = input.position;
  const line = lines[lineIndex];
  if (line === undefined || character < 0 || character > line.length || (input.ch === '\n' && lineIndex === 0)) {
    return [];
  }
  const trimmed = line.trimStart();
  const indentLength = line.length - trimmed.length;
  if (input.ch === '}' ? !trimmed.startsWith('}') || character !== indentLength + 1 : character > indentLength) {
    return [];
  }

  let indentLevel = 0;
  let inBlockComment = false;
  let inPreprocessor = false;
  let continuationDepth = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    if (index % 128 === 0) { yield; }
    const preceding = lines[index];
    const state = countStructuralBraces(preceding, inBlockComment);
    const isPreprocessor = inPreprocessor || state.preprocessorDirective !== undefined;
    // Branch selection needs preprocessing analysis; preserve editor indentation instead.
    if (!inPreprocessor && state.preprocessorDirective !== undefined
      && ['if', 'ifdef', 'ifndef', 'elif', 'else', 'endif'].includes(state.preprocessorDirective)) { return []; }
    inBlockComment = state.inBlockComment;
    // Macro braces do not affect source indentation, but comments can cross lines.
    if (isPreprocessor) {
      inPreprocessor = preceding.trimEnd().endsWith('\\');
      continue;
    }
    // Do not guess indentation after an unfinished or unsupported quoted token.
    if (state.unterminatedLiteral || state.unsupportedToken) { return []; }
    continuationDepth = Math.max(0, continuationDepth + state.continuationDelta);
    indentLevel = Math.max(0, indentLevel + state.opens - state.closes);
  }
  if (inBlockComment || inPreprocessor || continuationDepth > 0
    || countStructuralBraces(line, false).preprocessorDirective !== undefined) { return []; }
  const expectedIndent = lineIndentation(indentLevel, trimmed, input.options);
  if (line.slice(0, indentLength) === expectedIndent) { return []; }
  return [{
    range: {
      start: { line: lineIndex, character: 0 },
      end: { line: lineIndex, character: indentLength }
    },
    newText: expectedIndent
  }];
}

function lineIndentation(level: number, trimmed: string, options: AnalysisFormattingOptions): string {
  const lineLevel = Math.max(0, level - (trimmed.startsWith('}') ? 1 : 0));
  const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
  return unit.repeat(lineLevel);
}
