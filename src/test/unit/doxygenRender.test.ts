import * as assert from 'assert';
import type {
  BoundDocumentation,
  DocParameter,
  DocSource,
  ParsedDocumentation,
} from '../../analyzer/documentation/model';
import {
  renderDocumentation,
  renderParameterDocumentation,
} from '../../analyzer/documentation/render';

const source: DocSource = {
  uri: 'file:///doc.axl',
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  raw: '',
};

function text(value: string) {
  return { text: value, source };
}

function parameter(names: string[], value: string, direction?: DocParameter['direction']): DocParameter {
  return { ...text(value), names, ...(direction === undefined ? {} : { direction }) };
}

function document(overrides: Partial<ParsedDocumentation>): ParsedDocumentation {
  return {
    source,
    brief: [],
    details: [],
    parameters: [],
    returns: [],
    returnValues: [],
    supplements: [],
    targets: [],
    groups: [],
    unparsed: [],
    ...overrides,
  };
}

function bound(documents: ParsedDocumentation[], entries: ReadonlyMap<number, readonly DocParameter[]>, unmatched: readonly DocParameter[] = []): BoundDocumentation {
  return {
    documents,
    declaration: {
      id: 'function:Find',
      name: 'Find',
      kind: 'function',
      uri: source.uri,
      range: source.range,
      selectionRange: source.range,
      detail: 'int Find(string dir, string filename)',
    },
    parameterEntries: entries,
    unmatchedParameters: unmatched,
  };
}

suite('Doxygen render', () => {
  test('renders all sections in their specified order with Japanese headings', () => {
    const dir = parameter(['dir'], '検索するディレクトリ', 'in');
    const filename = parameter(
      ['filename'],
      '検索するファイル名。\n  - `*` は任意文字列\n  - `?` は1文字',
      'in',
    );
    const missing = parameter(['missing'], '宣言に存在しない引数', 'out');
    const docs = [
      document({
        brief: [text('ファイル検索を **初期化** します')],
        details: [
          text('`Next` を呼び出します。 [仕様](https://example.com/spec)'),
          text('```axel\n@param はコードです\n```'),
        ],
        returns: [text('検索を開始できたかどうか')],
        returnValues: [
          { ...text('正常 // TODO 調査'), value: '`1`' },
          { ...text('エラー'), value: '0' },
        ],
        supplements: [
          { ...text('最初の注記'), kind: 'note' },
          { ...text('利用を避けてください'), kind: 'deprecated' },
          { ...text('二つ目の注記'), kind: 'note' },
        ],
        unparsed: [text('@unknown 元の記述\n  続き')],
      }),
    ];
    const rendered = renderDocumentation(bound(docs, new Map([[1, [filename]], [0, [dir]]]), [missing]), 'ja-JP');

    assert.strictEqual(rendered.markdown, [
      'ファイル検索を **初期化** します',
      '',
      '**詳細**',
      '',
      '`Next` を呼び出します。 [仕様](https://example.com/spec)',
      '',
      '```axel',
      '@param はコードです',
      '```',
      '',
      '**引数**',
      '',
      '- [in] `dir` — 検索するディレクトリ',
      '- [in] `filename` — 検索するファイル名。',
      '    - `*` は任意文字列',
      '    - `?` は1文字',
      '',
      '**未解決の引数**',
      '',
      '- [out] `missing` — 宣言に存在しない引数',
      '',
      '**戻り値**',
      '',
      '検索を開始できたかどうか',
      '',
      '**戻り値の値**',
      '',
      '- `1` — 正常 // TODO 調査',
      '- `0` — エラー',
      '',
      '**注記**',
      '',
      '最初の注記',
      '',
      '**非推奨**',
      '',
      '利用を避けてください',
      '',
      '**注記**',
      '',
      '二つ目の注記',
      '',
      '```text',
      '@unknown 元の記述',
      '  続き',
      '```',
    ].join('\n'));

    assert.strictEqual(rendered.plainText, [
      'ファイル検索を 初期化 します',
      '',
      '詳細',
      '',
      'Next を呼び出します。 仕様 (https://example.com/spec)',
      '',
      '@param はコードです',
      '',
      '引数',
      '',
      '- [in] dir — 検索するディレクトリ',
      '- [in] filename — 検索するファイル名。',
      '    - * は任意文字列',
      '    - ? は1文字',
      '',
      '未解決の引数',
      '',
      '- [out] missing — 宣言に存在しない引数',
      '',
      '戻り値',
      '',
      '検索を開始できたかどうか',
      '',
      '戻り値の値',
      '',
      '- 1 — 正常 // TODO 調査',
      '- 0 — エラー',
      '',
      '注記',
      '',
      '最初の注記',
      '',
      '非推奨',
      '',
      '利用を避けてください',
      '',
      '注記',
      '',
      '二つ目の注記',
      '',
      '@unknown 元の記述',
      '  続き',
    ].join('\n'));
  });

  test('uses English headings for omitted and unsupported locales and omits empty sections', () => {
    const docs = [document({
      details: [text('Details body')],
      returnValues: [{ ...text(''), value: '1' }],
      supplements: [
        { ...text('Careful'), kind: 'warning' },
        { ...text('Write tests'), kind: 'todo' },
        { ...text('SX 8'), kind: 'version' },
        { ...text(''), kind: 'note' },
      ],
    })];
    const value = bound(docs, new Map());

    for (const locale of [undefined, 'fr-FR']) {
      const rendered = renderDocumentation(value, locale);
      assert.strictEqual(rendered.markdown, [
        '**Details**', '', 'Details body', '',
        '**Return values**', '', '- `1`', '',
        '**Warning**', '', 'Careful', '',
        '**TODO**', '', 'Write tests', '',
        '**Version**', '', 'SX 8',
      ].join('\n'));
      assert.ok(!rendered.markdown.includes('**Parameters**'));
      assert.ok(!rendered.markdown.includes('**Note**'));
    }
  });

  test('renders only the selected parameter entries and returns undefined when absent', () => {
    const first = parameter(['value'], 'first `code`', 'in,out');
    const second = parameter(['value'], 'second **description**');
    const value = bound([document({ parameters: [first, second] })], new Map([[0, [first, second]]]));

    assert.deepStrictEqual(renderParameterDocumentation(value, 0), {
      markdown: '[in,out] first `code`\n\nsecond **description**',
      plainText: '[in,out] first code\n\nsecond description',
    });
    assert.strictEqual(renderParameterDocumentation(value, 1), undefined);
    assert.strictEqual(renderParameterDocumentation(value, -1), undefined);
  });

  test('preserves Markdown-looking text inside an indented code block in plain text', () => {
    const value = bound([document({
      details: [text([
        'Example:',
        '',
        '    const string example = "**bold** `ticks`";',
      ].join('\n'))],
    })], new Map());

    const rendered = renderDocumentation(value);
    assert.strictEqual(rendered.markdown, [
      '**Details**',
      '',
      'Example:',
      '',
      '    const string example = "**bold** `ticks`";',
    ].join('\n'));
    assert.strictEqual(rendered.plainText, [
      'Details',
      '',
      'Example:',
      '',
      '    const string example = "**bold** `ticks`";',
    ].join('\n'));
  });
});
