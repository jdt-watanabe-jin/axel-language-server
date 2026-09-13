import * as assert from 'assert';
import { analyze, analyzeMarked } from '../../support/source';
import { getHover } from '../../../analyzer/hover';
import { getSignatureHelp } from '../../../analyzer/signatureHelp';

suite('Doxygen binding', () => {
  function hover(text: string) {
    const input = analyzeMarked(text);
    return getHover({ ...input, workspaceIndex: {} });
  }
  test('renders documented parameters instead of raw tags', () => {
    const result = hover('/*!\n * @brief Search files\n * @param[in] dir Directory\n * @retval 1\n */\nint Find(string dir);\nvoid main(){ Fi|nd("."); }');
    assert.ok(result?.markdown?.includes('Search files'));
    assert.ok(result?.markdown?.includes('Directory'));
    assert.ok(!result?.markdown?.includes('@brief'));
    assert.ok(!result?.markdown?.includes('@param'));
  });
  test('associates across blank lines and retains detailed paragraphs', () => {
    const result = hover('/*! @brief Summary\n *\n * First paragraph\n *\n * Second paragraph\n */\n\nint Find();\nvoid main(){ Fi|nd(); }');
    assert.ok(result?.markdown?.includes('Summary'));
    assert.ok(result?.markdown?.includes('First paragraph\n\nSecond paragraph'));
  });
  test('resolves a distant fn and does not attach it to the next function', () => {
    const source = 'int Find(int n);\n/*! @fn int Find(int count)\n * @brief Search files\n */\n// boundary\nint Other();\n';
    assert.ok(hover(source + 'void main(){ Fi|nd(1); }')?.markdown?.includes('Search files'));
    assert.ok(!hover(source + 'void main(){ Ot|her(); }')?.plainText.includes('Search files'));
  });
  test('uses the adjacent function even when fn names a different target', () => {
    const result = hover('/*! @fn int Missing(int n)\n * @brief Wrong target\n */\nint Find();\nvoid main(){ Fi|nd(); }');
    assert.ok(result?.plainText.includes('Wrong target'));
  });
  test('resolves overloads by parameter types while ignoring parameter names', () => {
    const source = 'int Find(int n);\nint Find(string s);\n/*! @fn int Find(string name)\n * @brief String search\n */\n// boundary\n';
    assert.ok(hover(source + 'void main(){ Fi|nd("x"); }')?.plainText.includes('String search'));
    assert.ok(!hover(source.replace('int Find(int n)', 'int Fi|nd(int n)'))?.plainText.includes('String search'));
  });
  test('keeps a group title out of the next declaration', () => {
    const result = hover('/*! @defgroup group Group title\n * @{\n */\nint Find();\nvoid main(){ Fi|nd(); }');
    assert.ok(!result?.plainText.includes('Group title'));
    assert.ok(!result?.plainText.includes('@{'));
  });
  test('does not attach a trailing document to the next declaration', () => {
    const result = hover('int before; ///< Previous field\nint Find();\nvoid main(){ Fi|nd(); }');
    assert.ok(!result?.plainText.includes('Previous field'));
  });
  test('keeps ordinary banners as literal descriptions', () => {
    assert.ok(hover('/**** Banner docs */\nint Fi|nd();')?.plainText.includes('Banner docs'));
  });
  test('keeps ordinary comments as literal descriptions', () => {
    const result = hover('// @brief literal\nint Find();\nvoid main(){ Fi|nd(); }');
    assert.ok(result?.plainText.includes('@brief literal'));
  });
  test('provides selected parameter documentation', () => {
    const input = analyzeMarked('/*! @param[in] n Count\n * @param[out] text Result\n */\nvoid Find(int n, string *text);\nvoid main(){ string s; Find(1, |&s); }');
    const help = getSignatureHelp({ ...input, workspaceIndex: {} });
    assert.strictEqual(help?.activeParameter, 1);
    assert.ok(JSON.stringify(help?.signatures[0].parameters[1]).includes('Result'));
  });
  test('retains the original declarations when documentation is present', () => {
    const analysis = analyze('/*! @fn int Missing()\n * @brief Absent\n */\nint Existing();');
    assert.ok(!analysis.declarations.some(d => d.name === 'Missing'));
  });
  test('matches documented class members and typedef names', () => {
    assert.ok(hover('/*! @class C\n * @brief Class docs\n */\nclass |C { int member; };')?.plainText.includes('Class docs'));
    assert.ok(hover('class C { /*! @var int member\n * @brief Member docs\n */\nint mem|ber; };')?.plainText.includes('Member docs'));
    assert.ok(hover('/*! @typedef Count\n * @brief Alias docs\n */\ntypedef int Cou|nt;')?.plainText.includes('Alias docs'));
  });
  test('matches qualified distant methods and function pointer parameter types', () => {
    const source = 'class C { int Run(void (*cb)(int)); };\n/*! @fn int C::Run(void (*callback)(int))\n * @brief Callback docs\n */';
    assert.ok(hover(source.replace('int Run(', 'int Ru|n('))?.plainText.includes('Callback docs'));
    const wrong = source.replace('(*callback)(int)', '(*callback)(string)');
    assert.ok(!hover(wrong.replace('int Run(', 'int Ru|n('))?.plainText.includes('Callback docs'));
  });
  test('uses a documented type alias when matching function parameters', () => {
    const source = 'typedef int Count;\nint Find(Count n);\n/*! @fn int Find(int count)\n * @brief Alias parameter\n */';
    assert.ok(hover(source.replace('int Find(', 'int Fi|nd('))?.plainText.includes('Alias parameter'));
  });
  test('does not cross an ordinary comment or statement without a target', () => {
    assert.ok(!hover('/*! @brief unrelated */\n// boundary\nint Fi|nd();')?.plainText.includes('unrelated'));
    assert.ok(!hover('/*! @brief unrelated */\n#define BARRIER 1\nint Fi|nd();')?.plainText.includes('unrelated'));
  });
  test('merges adjacent doc blocks without losing the first paragraph', () => {
    assert.ok(hover('/*! @brief First */\n/*! @details Second */\nint Fi|nd();')?.plainText.includes('First'));
    assert.ok(hover('/*! @brief First */\n/*! @details Second */\nint Fi|nd();')?.plainText.includes('Second'));
  });
  test('does not choose between conflicting distant documentation blocks', () => {
    const text = 'int Fi|nd();\n/*! @fn int Find()\n * @brief First\n */\n/*! @fn int Find()\n * @brief Second\n */';
    const result = hover(text);
    assert.ok(!result?.plainText.includes('First'));
    assert.ok(!result?.plainText.includes('Second'));
  });
  test('borrows definition documentation without replacing declaration documentation', () => {
    assert.ok(hover('int Fi|nd(int n);\n/*! @brief Definition docs */\nint Find(int value) { return value; }')?.plainText.includes('Definition docs'));
    const result = hover('/*! @brief Declaration docs */\nint Fi|nd(int n);\n/*! @brief Definition docs */\nint Find(int value) { return value; }');
    assert.ok(result?.plainText.includes('Declaration docs'));
    assert.ok(!result?.plainText.includes('Definition docs'));
  });
  test('preserves literal declaration documentation over definition fallback', () => {
    const result = hover('// Declaration docs\nint Fi|nd(int n);\n/*! @brief Definition docs */\nint Find(int value) { return value; }');
    assert.ok(result?.plainText.includes('Declaration docs'));
    assert.ok(!result?.plainText.includes('Definition docs'));
  });
  test('borrows parameter documentation by ordinal when declaration names differ', () => {
    const input = analyzeMarked('/*! @param value Count */\nint Find(int value) { return value; }\nint Find(int n);\nvoid main(){ Find(|1); }');
    const help = getSignatureHelp({...input, workspaceIndex:{}});
    assert.ok(JSON.stringify(help?.signatures[0].parameters[0]).includes('Count'));
    assert.ok(!help?.signatures[0].documentation?.includes('Unmatched parameters'));
  });
  test('uses definition parameter positions for explicit targets shared with a prototype', () => {
    const input = analyzeMarked('/*! @fn int Find(int value)\n * @param value Count */\nint Find(int value) { return value; }\nint Find(int n);\nvoid main(){ Find(|1); }');
    const help = getSignatureHelp({...input, workspaceIndex:{}});
    assert.ok(JSON.stringify(help?.signatures[0].parameters[0]).includes('Count'));
  });
  test('maps optional, unnamed and variadic documentation to actual parameters', () => {
    const input = analyzeMarked('/*! @param 1 Anonymous\n * @param[in] ... Values\n */\nint Find(int, int ...);\nvoid main(){ Find(1, 2, |3); }');
    const help = getSignatureHelp({...input, workspaceIndex:{}});
    assert.strictEqual(help?.activeParameter, 1);
    assert.ok(JSON.stringify(help?.signatures[0].parameters[0]).includes('Anonymous'));
    assert.ok(JSON.stringify(help?.signatures[0].parameters[1]).includes('Values'));
  });

  test('accepts a bare var name used by shipped headers', () => {
    assert.ok(hover('class DATE { /*! @var year\n * @brief Calendar year\n */\nshort ye|ar; };')?.plainText.includes('Calendar year'));
  });
  test('rejects conflicting return declarations rather than selecting by return type', () => {
    const text = 'int Fi|nd(int n);\nvoid Find(int n);\n/*! @fn int Find(int n)\n * @brief Conflict\n */';
    assert.ok(!hover(text)?.plainText.includes('Conflict'));
  });

});
