import * as assert from 'assert';
import { createAxelParser } from '../../analyzer/axelParser';
import { extractDocumentationComments } from '../../analyzer/documentation/comments';
import { parseDocumentation } from '../../analyzer/documentation/parse';
import type { ParsedDocumentation } from '../../analyzer/documentation/model';

suite('Doxygen parse', () => {
  function parse(body: string, marker: '/*!' | '/**' = '/*!'): ParsedDocumentation {
    const text = `${marker}\n${body.split('\n').map(line => ` *${line.length === 0 ? '' : ` ${line}`}`).join('\n')}\n */`;
    const root = createAxelParser().parse(text).rootNode;
    const [comment] = extractDocumentationComments(root, text, 'file:///doc.axl');
    return parseDocumentation(comment);
  }

  function content(doc: ParsedDocumentation) {
    return {
      brief: doc.brief.map(item => item.text),
      details: doc.details.map(item => item.text),
      parameters: doc.parameters.map(item => ({ names: item.names, direction: item.direction, text: item.text })),
      returns: doc.returns.map(item => item.text),
      returnValues: doc.returnValues.map(item => ({ value: item.value, text: item.text })),
      supplements: doc.supplements.map(item => ({ kind: item.kind, text: item.text })),
      targets: doc.targets.map(item => ({ kind: item.kind, text: item.text })),
      groups: doc.groups.map(item => ({ kind: item.kind, text: item.text })),
      unparsed: doc.unparsed.map(item => item.text)
    };
  }

  test('parses at-sign and backslash command markers identically', () => {
    const at = parse('@brief Search\n@param[in] count item count\n@return found item');
    const slash = parse('\\brief Search\n\\param[in] count item count\n\\return found item', '/**');
    assert.deepStrictEqual(content(at), content(slash));
  });

  test('normalizes all general return aliases', () => {
    const doc = parse('@return first\n@returns second\n@result third');
    assert.deepStrictEqual(doc.returns.map(item => item.text), ['first', 'second', 'third']);
  });

  test('retains empty retval descriptions and repeated details', () => {
    const doc = parse('@retval 1\n@details first\n@details second');
    assert.deepStrictEqual(doc.returnValues.map(value => [value.value, value.text]), [['1', '']]);
    assert.deepStrictEqual(doc.details.map(paragraph => paragraph.text), ['first', 'second']);
  });

  test('retains repeated briefs and return values in source order', () => {
    const doc = parse('@brief first\n@brief second\n@retval 1 success\n@retval 0 failure');
    assert.deepStrictEqual(doc.brief.map(item => item.text), ['first', 'second']);
    assert.deepStrictEqual(doc.returnValues.map(item => [item.value, item.text]), [
      ['1', 'success'], ['0', 'failure']
    ]);
  });

  test('keeps wrapped descriptions and resumes ordinary details after a blank line', () => {
    const doc = parse('@brief first line\ncontinuation\n\nordinary detail\n  - nested');
    assert.deepStrictEqual(doc.brief.map(item => item.text), ['first line\ncontinuation']);
    assert.deepStrictEqual(doc.details.map(item => item.text), ['ordinary detail\n  - nested']);
  });

  test('normalizes accepted parameter directions and comma-separated names', () => {
    const doc = parse([
      '@param first no direction',
      '@param[in] input input only',
      '@param [out] output output only',
      '@param[in,out] both1,both2 both',
      '@param[out in] reversed reverse order',
      '@param[inout] joined joined direction',
      '@param[outin] joinedReverse reverse joined direction'
    ].join('\n'));
    assert.deepStrictEqual(doc.parameters.map(item => [item.names, item.direction]), [
      [['first'], undefined],
      [['input'], 'in'],
      [['output'], 'out'],
      [['both1', 'both2'], 'in,out'],
      [['reversed'], 'in,out'],
      [['joined'], 'in,out'],
      [['joinedReverse'], 'in,out']
    ]);
  });

  test('retains positional, unnamed, and variadic parameter selectors', () => {
    const doc = parse('@param 1 first\n@param - unnamed\n@param ... remaining');
    assert.deepStrictEqual(doc.parameters.map(item => item.names), [['1'], ['-'], ['...']]);
  });

  test('retains all five supplement kinds and repetitions', () => {
    const doc = parse([
      '@note note one', '@warning warning one', '@deprecated use New',
      '@todo investigate', '@version 2.0', '@note note two'
    ].join('\n'));
    assert.deepStrictEqual(doc.supplements.map(item => [item.kind, item.text]), [
      ['note', 'note one'], ['warning', 'warning one'], ['deprecated', 'use New'],
      ['todo', 'investigate'], ['version', '2.0'], ['note', 'note two']
    ]);
  });

  test('retains all five structural target kinds without adding them to details', () => {
    const doc = parse([
      '@fn int Find(int count)', '@class Searcher', '@var Searcher::count',
      '@def MAX_COUNT', '@typedef Count'
    ].join('\n'));
    assert.deepStrictEqual(doc.targets.map(item => [item.kind, item.text]), [
      ['fn', 'int Find(int count)'], ['class', 'Searcher'], ['var', 'Searcher::count'],
      ['def', 'MAX_COUNT'], ['typedef', 'Count']
    ]);
    assert.deepStrictEqual(doc.details, []);
  });

  test('distinguishes all five group structures from symbol text', () => {
    const doc = parse([
      '@ingroup search', '@defgroup search Search functions', '@addtogroup search Search functions',
      '@{', '@}'
    ].join('\n'));
    assert.deepStrictEqual(doc.groups.map(item => [item.kind, item.text]), [
      ['ingroup', 'search'], ['defgroup', 'search Search functions'],
      ['addtogroup', 'search Search functions'], ['{', ''], ['}', '']
    ]);
    assert.deepStrictEqual(doc.details, []);
  });

  test('does not interpret commands inside fenced or inline code', () => {
    const doc = parse([
      '@details before `@param inline`',
      '```axel',
      '@param hidden fenced command',
      '',
      'puts("\\\\details"); // TODO investigate',
      '```',
      'after'
    ].join('\n'));
    assert.deepStrictEqual(doc.parameters, []);
    assert.strictEqual(doc.details.length, 1);
    assert.ok(doc.details[0].text.includes('@param hidden fenced command'));
    assert.ok(doc.details[0].text.includes('// TODO investigate'));
  });

  test('does not interpret commands in a four-space indented Markdown code block', () => {
    const doc = parse([
      '@details Example',
      '',
      '    @param hidden parameter text',
      '    @return hidden return text',
      '',
      '@param visible visible parameter text'
    ].join('\n'));
    assert.deepStrictEqual(doc.parameters.map(item => [item.names, item.text]), [
      [['visible'], 'visible parameter text']
    ]);
    assert.deepStrictEqual(doc.returns, []);
    assert.ok(doc.details.some(item => item.text.includes('    @param hidden parameter text')));
    assert.ok(doc.details.some(item => item.text.includes('    @return hidden return text')));
  });

  test('transitions between paragraph commands on the same line', () => {
    const doc = parse('@brief First @details Second @note Third');
    assert.deepStrictEqual(doc.brief.map(item => item.text), ['First']);
    assert.deepStrictEqual(doc.details.map(item => item.text), ['Second']);
    assert.deepStrictEqual(doc.supplements.map(item => [item.kind, item.text]), [['note', 'Third']]);
  });

  test('protects inline code while finding a later same-line command', () => {
    const doc = parse('@brief First `@details hidden` @details Second');
    assert.deepStrictEqual(doc.brief.map(item => item.text), ['First `@details hidden`']);
    assert.deepStrictEqual(doc.details.map(item => item.text), ['Second']);
  });

  test('keeps structural line arguments intact when they contain command-like text', () => {
    const doc = parse('@fn void Find() @brief part of the declaration text');
    assert.deepStrictEqual(doc.targets.map(item => [item.kind, item.text]), [
      ['fn', 'void Find() @brief part of the declaration text']
    ]);
    assert.deepStrictEqual(doc.brief, []);
  });

  test('retains unknown commands and recovers at the next supported command', () => {
    const doc = parse('@unknown original\nunknown continuation\n@param value supported');
    assert.deepStrictEqual(doc.unparsed.map(item => item.text), ['@unknown original\nunknown continuation']);
    assert.deepStrictEqual(doc.parameters.map(item => [item.names, item.text]), [[['value'], 'supported']]);
  });

  test('retains an invalid parameter direction as unparsed source', () => {
    const doc = parse('@param[input] value invalid\n@return still parsed');
    assert.deepStrictEqual(doc.parameters, []);
    assert.deepStrictEqual(doc.unparsed.map(item => item.text), ['@param[input] value invalid']);
    assert.deepStrictEqual(doc.returns.map(item => item.text), ['still parsed']);
  });

  test('retains unsupported command spelling and its original marker exactly', () => {
    const doc = parse('\\unknown original marker\n@Brief case sensitive\n@return recovered');
    assert.deepStrictEqual(doc.unparsed.map(item => item.text), [
      '\\unknown original marker', '@Brief case sensitive'
    ]);
    assert.deepStrictEqual(doc.returns.map(item => item.text), ['recovered']);
  });

  test('keeps commands inside a multiline inline code span across a blank line', () => {
    const doc = parse('@details `code span\n\n@param hidden still code`\n@return visible');
    assert.deepStrictEqual(doc.parameters, []);
    assert.deepStrictEqual(doc.details.map(item => item.text), [
      '`code span\n\n@param hidden still code`'
    ]);
    assert.deepStrictEqual(doc.returns.map(item => item.text), ['visible']);
  });

  test('keeps escaped markers and email addresses as ordinary text', () => {
    const doc = parse('@details contact user@example.com\n\\@param literal marker');
    assert.deepStrictEqual(doc.parameters, []);
    assert.deepStrictEqual(doc.details.map(item => item.text), [
      'contact user@example.com\n\\@param literal marker'
    ]);
  });

  test('preserves backticked and Japanese return-value labels without reclassification', () => {
    const doc = parse('@retval `ERR_BUSY` retry later\n@retval 部品のアドレス');
    assert.deepStrictEqual(doc.returnValues.map(item => [item.value, item.text]), [
      ['`ERR_BUSY`', 'retry later'], ['部品のアドレス', '']
    ]);
    assert.deepStrictEqual(doc.returns, []);
  });

  test('retains original CRLF separators in a multiline entry source', () => {
    const text = '/*!\r\n * @brief first\r\n * continuation\r\n */';
    const [comment] = extractDocumentationComments(createAxelParser().parse(text).rootNode, text, 'file:///doc.axl');
    const doc = parseDocumentation(comment);
    assert.strictEqual(doc.brief[0].source.raw, ' * @brief first\r\n * continuation');
  });

  test('attaches original source locations to parsed entries', () => {
    const doc = parse('@brief 概要\n@param value 説明');
    assert.strictEqual(doc.brief[0].source.uri, 'file:///doc.axl');
    assert.ok(doc.brief[0].source.raw.includes('@brief 概要'));
    assert.deepStrictEqual(doc.brief[0].source.range.start, { line: 1, character: 0 });
    assert.deepStrictEqual(doc.parameters[0].source.range.start, { line: 2, character: 0 });
  });
});
