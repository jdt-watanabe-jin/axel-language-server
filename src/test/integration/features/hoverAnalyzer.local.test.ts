import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getHover } from '../../../analyzer/hover';
import { analyze, analyzeMarked, positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';
suite('getHover', () => {
  test('returns a function declaration hover at its name', () => {
    const analysis = analyze('void main() {}');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 5 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid main()\n```',
      plainText: 'void main()'
    });
  });

  test('returns qualified hover for method and operator declarations', () => {
    const text = [
      'class FILEIter {',
      '  int Next();',
      '  int operator++ ();',
      '};'
    ].join('\n');
    const analysis = analyze(text);

    const nextHover = getHover({
      analysis,
      position: { line: 1, character: 6 },
      workspaceIndex: {}
    });
    const operatorHover = getHover({
      analysis,
      position: { line: 2, character: 6 },
      workspaceIndex: {}
    });

    assert.strictEqual(nextHover?.plainText, 'int FILEIter::Next()');
    assert.strictEqual(operatorHover?.plainText, 'int FILEIter::operator++ ()');
  });

  test('returns destructor hover on the destructor class name', () => {
    const text = [
      'CTGen::CTGen() {}',
      'CTGen::~CTGen() {}'
    ].join('\n');
    const analysis = analyze(text);

    const tildeHover = getHover({
      analysis,
      position: { line: 1, character: 7 },
      workspaceIndex: createWorkspaceIndex()
    });
    const classNameHover = getHover({
      analysis,
      position: { line: 1, character: 9 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.strictEqual(tildeHover?.plainText, 'CTGen::~CTGen()');
    assert.strictEqual(classNameHover?.plainText, 'CTGen::~CTGen()');
  });

  test('returns class hover for return types before qualified methods', () => {
    const text = [
      'class Version {};',
      'Version::Version() {}',
      'static Version Version::makeVersion(int p_major)',
      '{',
      '  return makeVersion(p_major);',
      '}'
    ].join('\n');
    const analysis = analyze(text);

    const hover = getHover({
      analysis,
      position: { line: 2, character: 'static '.length },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.strictEqual(hover?.plainText, 'class Version');
  });

  test('returns declaration documentation when hovering a reference', () => {
    const analysis = analyze([
      '// Value shown to users.',
      'int label;',
      'void main() { label = 1; }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 2, character: 14 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: [
        '```axel',
        'int label',
        '```',
        '',
        'Value shown to users.'
      ].join('\n'),
      plainText: 'int label\nValue shown to users.'
    });
  });

  test('does not resolve a reference to a later declaration in the same scope', () => {
    const analysis = analyze('void main() { local = 1; int local; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 14 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.strictEqual(hover, null);
  });

  test('resolves a reference to the nearest preceding declaration in a nested scope', () => {
    const analysis = analyze([
      'void main() {',
      '  int value;',
      '  { struct value {}; value instance; }',
      '}'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 2, character: 22 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nstruct value\n```',
      plainText: 'struct value'
    });
  });

  test('returns member hover for a static qualified method call', () => {
    const analysis = analyze([
      'class FILE { static int IsDirectory(string path) {} };',
      'void main() { FILE::IsDirectory("x"); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 1, character: 20 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nstatic int FILE::IsDirectory(string path)\n```',
      plainText: 'static int FILE::IsDirectory(string path)'
    });
  });

  test('returns hover for the overload matching the call argument count', () => {
    const analysis = analyze([
      'class Version {};',
      'static Version Version::makeVersion(int major, int minor, int patch, int prerelease, int number) {}',
      'static Version Version::makeVersion(int major, int minor, int patch) {',
      '  return makeVersion(major, minor, patch, 0, 0);',
      '}',
      'static Version Version::makeVersion(int major) {}',
      'void main() { Version::makeVersion(1); Version::makeVersion(1, 2, 3); }'
    ].join('\n'));

    const oneArgumentHover = getHover({
      analysis,
      position: { line: 6, character: 23 },
      workspaceIndex: createWorkspaceIndex()
    });
    const threeArgumentHover = getHover({
      analysis,
      position: { line: 6, character: 48 },
      workspaceIndex: createWorkspaceIndex()
    });
    const fiveArgumentHover = getHover({
      analysis,
      position: { line: 3, character: 9 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.strictEqual(oneArgumentHover?.plainText, 'static Version Version::makeVersion(int major)');
    assert.strictEqual(
      threeArgumentHover?.plainText,
      'static Version Version::makeVersion(int major, int minor, int patch)'
    );
    assert.strictEqual(
      fiveArgumentHover?.plainText,
      'static Version Version::makeVersion(int major, int minor, int patch, int prerelease, int number)'
    );
  });

  test('returns class hover for a static qualified receiver', () => {
    const analysis = analyze([
      'class myDlg { static void DoModless() {} };',
      'void main() { myDlg::DoModless(); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 1, character: 16 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nclass myDlg\n```',
      plainText: 'class myDlg'
    });
  });

  test('resolves a parameter reference to its declaration', () => {
    const analysis = analyze('void update(int count) { count = 1; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 26 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint count\n```',
      plainText: 'int count'
    });
  });

  test('resolves method calls through dot and arrow receivers', () => {
    const analysis = analyze([
      'int method() {} class Widget { void method() {} };',
      'void main() { Widget var; Widget *ptr; var.method(); ptr->method(); }'
    ].join('\n'));

    const dotHover = getHover({
      analysis,
      position: { line: 1, character: 44 },
      workspaceIndex: createWorkspaceIndex()
    });
    const arrowHover = getHover({
      analysis,
      position: { line: 1, character: 59 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(dotHover, {
      markdown: '```axel\nvoid Widget::method()\n```',
      plainText: 'void Widget::method()'
    });
    assert.deepStrictEqual(arrowHover, {
      markdown: '```axel\nvoid Widget::method()\n```',
      plainText: 'void Widget::method()'
    });
  });

  test('resolves inherited method calls through the receiver type base class', () => {
    const { analysis, position } = analyzeMarked([
      'class Base { void inherited() {} };',
      'class Child : public Base {};',
      'void main() { Child child; child.|inherited(); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid Base::inherited()\n```',
      plainText: 'void Base::inherited()'
    });
  });

  test('resolves a qualified out-of-class method through its receiver type', () => {
    const analysis = analyze([
      'int measure() {}',
      'class Widget {};',
      'double Widget::measure(float scale) {}',
      'void main() { Widget widget; widget.measure(1); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 3, character: 36 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\ndouble Widget::measure(float scale)\n```',
      plainText: 'double Widget::measure(float scale)'
    });
  });

  test('returns resolved AXEL execution file hover at a command file name', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const scriptPath = path.join(tempDir, 'test.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(scriptPath, 'void main() {}');
    const index = createWorkspaceIndex();
    const markedText = 'void main() { string infile; |@test -i `infile`; }';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const hover = getHover({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assert.deepStrictEqual(hover, {
      markdown: `\`\`\`text\naxel: ${scriptPath}\n\`\`\``,
      plainText: `axel: ${scriptPath}`
    });
    assert.strictEqual(getHover({
      analysis, position: positionFromOffset(text, markerOffset), workspaceIndex: index, locale: 'ja'
    })?.plainText, `AXEL 実行ファイル: ${scriptPath}`);
  });

  test('resolves enum member references to their declaration', () => {
    const analysis = analyze('enum Mode { A, B = 2 }; void main() { Mode mode; mode = B; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 56 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nenum Mode::B = 2\n```',
      plainText: 'enum Mode::B = 2'
    });
  });

  test('resolves a local declaration named printf', () => {
    const analysis = analyze('void main() { int printf; printf = 1; unknown = 2; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 26 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.strictEqual(getHover({ analysis, position: { line: 0, character: 38 }, workspaceIndex: createWorkspaceIndex() }), null);
    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint printf\n```',
      plainText: 'int printf'
    });
  });

  test('resolves this arrow member access inside a method body', () => {
    const { analysis, position } = analyzeMarked([
      'class Base { int inheritedValue; };',
      'class Child : public Base {',
      '  int directValue;',
      '  void update() { this->|inheritedValue = directValue; }',
      '};'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint Base::inheritedValue\n```',
      plainText: 'int Base::inheritedValue'
    });
  });

  test('resolves this arrow methods inside an out-of-class method body', () => {
    const { analysis, position } = analyzeMarked([
      'class Widget {',
      '  void update();',
      '  int value() {}',
      '};',
      'void Widget::update() { this->|value(); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint Widget::value()\n```',
      plainText: 'int Widget::value()'
    });
  });

  test('does not throw for a syntax-error document', () => {
    const analysis = analyze('void broken( { int recovered;');

    assert.doesNotThrow(() => getHover({
      analysis,
      position: { line: 0, character: 5 },
      workspaceIndex: createWorkspaceIndex()
    }));
  });
});

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
