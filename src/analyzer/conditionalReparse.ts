import type * as Parser from 'tree-sitter';
import type { AnalyzeDocumentInput } from '../types/analysis';
import { evaluatePreprocessor, type PreprocessorEvaluation } from './preprocessorEvaluation';

interface Directive { start: number; end: number; conditional: boolean }

/** Lex directive boundaries only. Tree-sitter still parses all conditions and AXEL syntax. */
function directivesIn(text: string): Directive[] {
  const directives: Directive[] = [];
  for (let i = 0; i < text.length;) {
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (text.startsWith('//', i)) {
      do {
        const end = text.indexOf('\n', i);
        if (end < 0) { i = text.length; break; }
        const continued = text.slice(i, end).trimEnd().endsWith('\\');
        i = end + 1;
        if (!continued) { break; }
      } while (i < text.length);
    } else if (text[i] === '"' || text[i] === "'") {
      const quote = text[i++];
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; }
        else if (text[i++] === quote) { break; }
      }
    } else if (text[i] === '#' && text.slice(text.lastIndexOf('\n', i - 1) + 1, i).trim() === '') {
      const start = i;
      do {
        const end = text.indexOf('\n', i);
        if (end < 0) { i = text.length; break; }
        const continued = text.slice(i, end).trimEnd().endsWith('\\');
        i = end + 1;
        if (!continued) { break; }
      } while (i < text.length);
      directives.push({start, end:i, conditional:/^#\s*(?:if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b/.test(text.slice(start,i))});
    } else { i++; }
  }
  return directives;
}

/** Recover branch-spanning syntax while retaining the original UTF-16 offsets and newlines. */
export function conditionalReparse(input: AnalyzeDocumentInput, parse: (text: string) => Parser.Tree):
  {text: string; evaluation: PreprocessorEvaluation} | undefined {
  const source = input.text;
  const directives = directivesIn(source);
  if (!directives.some(d => d.conditional)) { return undefined; }
  const lines = source.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');
  const projection = blank(source).split('');
  for (const d of directives) {
    for (let i = d.start; i < d.end; i++) { projection[i] = source[i]; }
  }
  const directiveRoot = parse(projection.join('')).rootNode;
  if (directiveRoot.hasError) { return undefined; }
  const evaluation = evaluatePreprocessor(directiveRoot, input.preprocessorSymbols, input.tool, input.targetPlatform, input.internalFeatures, true);
  // Keep inactive highlighting on the branch's content, excluding the next directive's line.
  evaluation.inactiveRanges = evaluation.inactiveRanges.map(range =>
    range.end.character === 0 && range.end.line > range.start.line
      ? {...range, end:{line:range.end.line - 1, character:lines[range.end.line - 1].replace(/\r$/, '').length}}
      : range);
  const result = source.split('');
  const erase = (start: number, end: number) => {
    for (let i = start; i < end; i++) { if (result[i] !== '\r' && result[i] !== '\n') { result[i] = ' '; } }
  };
  for (const range of evaluation.inactiveRanges) {
    erase(starts[range.start.line] + range.start.character, starts[range.end.line] + range.end.character);
  }
  const uncertain = evaluation.uncertainConditionalRanges ?? [];
  for (const d of directives) {
    if (d.conditional && !uncertain.some(r => d.start >= starts[r.start.line] + r.start.character
      && d.start < starts[r.end.line] + r.end.character)) { erase(d.start, d.end); }
  }
  const text = result.join('');
  return text === source ? undefined : {text, evaluation};
}
