import * as assert from 'assert';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';

export function analyze(text: string) {
  return new DocumentAnalyzer().analyzeDocument({ uri: 'file:///main.axl', version: 1, text });
}
export function positionFromOffset(text: string, offset: number) {
  assert.ok(offset >= 0 && offset <= text.length, 'Source offset must exist');
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}
export function marked(markedText: string) {
  const offset = markedText.indexOf('|');
  assert.notStrictEqual(offset, -1, 'Expected a cursor marker |');
  const text = markedText.replace('|', '');
  return { text, position: positionFromOffset(text, offset) };
}
export function analyzeMarked(markedText: string) {
  const input = marked(markedText);
  return { ...input, analysis: analyze(input.text) };
}
