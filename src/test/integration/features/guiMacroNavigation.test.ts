import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getCompletions } from '../../../analyzer/completion';
import { collectSemanticTokens } from '../../../analyzer/semanticTokens';
import { getRenameEdits } from '../../../analyzer/rename';
import { getSignatureHelp } from '../../../analyzer/signatureHelp';
import { collectSemanticDiagnostics } from '../../../analyzer/semanticDiagnostics';
import { findEnclosingGuiMethodContext } from '../../../analyzer/guiResolution';
import { resolveImplicitGuiReference } from '../../../analyzer/guiReferenceResolution';
import { getHover } from '../../../analyzer/hover';
import { getDefinitions, getReferences } from '../../../analyzer/navigation';
import { analyzeMarked, positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';
import { recoveredStaticMemberFixture } from '../../support/recoveredStaticMember';

suite('GUI member navigation after macro expansion', () => {
  const { createWorkspaceIndex } = useWorkspaceFixtures();
  for (const [type, member, instance] of [
    ['GCLabel', 'text', ''],
    ['GCPushButton', 'pixmap', 'loadBTN']
  ]) {
    for (const expression of [member, `IDENTITY(${member})`]) {
      test(`${type} ${expression} resolves the same member as hover`, () => {
        const { analysis, position, text } = analyzeMarked([
          '#define VALUE "example"',
          '#define IDENTITY(x) x',
          `class ${type} { string ${member}; };`,
          'class AdcDlg : public GCDialog {',
          '  GCVBoxLayout { GCHBoxLayout {',
          `    ${type} ${instance} { OnCreate() { ${expression.replace(member, `|${member}`)} = VALUE; } };`,
          '  }; };',
          '};'
        ].join('\n'));
        const input = { analysis, position, workspaceIndex: createWorkspaceIndex() };
        assert.ok(analysis.navigationReferences, 'Fixture must expand a macro');
        assert.ok(getHover(input)?.plainText.includes(`${type}::${member}`), getHover(input)?.plainText);
        assert.ok(collectSemanticTokens(analysis, input.workspaceIndex).some(token =>
          token.range.start.line === position.line && token.range.start.character === position.character && token.tokenType === 'variable'));
        if (expression === member) {
          assert.ok(getCompletions({ ...input, text, position: { ...position, character: position.character + 1 } }).some(item => item.name === member && item.detail?.includes(`${type}::${member}`)));
        }
        const start = { line: 2, character: `class ${type} { string `.length };
        const range = { start, end: { ...start, character: start.character + member.length } };
        assert.deepStrictEqual(getDefinitions(input), [{ uri: analysis.uri, range }]);
        const edits = getRenameEdits({ ...input, newName: 'renamed' });
        assert.ok('changes' in edits);
        assert.strictEqual(edits.changes[analysis.uri].length, 2);
        assert.deepStrictEqual(getReferences({ ...input, position: start, includeDeclaration: false }), [
          { uri: analysis.uri, range: { start: position, end: { ...position, character: position.character + member.length } } }
        ]);
      });
    }
  }
});

suite('GUI implicit method feature agreement', () => {
  const { createWorkspaceIndex, createTempDir } = useWorkspaceFixtures();
  test('an inherited GUI property wins over an unrelated global declaration', () => {
    const directory = createTempDir();
    const headerPath = path.join(directory, 'widget.h');
    fs.writeFileSync(headerPath, [
      'int text;',
      'class GCWidget { string text; };',
      'class GCLabel : public GCWidget {};'
    ].join('\n'));
    const text = '#include "widget.h"\nclass Dialog : public GCDialog { GCLabel { OnCreate() { text = "label"; } }; };';
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const workspaceIndex = createWorkspaceIndex();
    const analysis = workspaceIndex.indexOpenDocument({ uri, version: 1, text });
    const position = positionFromOffset(text, text.indexOf('text ='));
    const input = { analysis, position, workspaceIndex };
    assert.strictEqual(getHover(input)?.plainText.split('\n')[0], 'string GCWidget::text');
    assert.deepStrictEqual(getDefinitions(input), [{
      uri: pathToFileURL(headerPath).toString(),
      range: { start: { line: 1, character: 24 }, end: { line: 1, character: 28 } }
    }]);
  });

  for (const [declaration, expression, name] of [
    ['int unrelated;', 'unrelated', 'unrelated'],
    ['void Unrelated();', 'Unrelated()', 'Unrelated'],
    ['static int Unrelated();', 'Unrelated()', 'Unrelated']
  ]) {
    test(`GUI member lookup excludes a class-external declaration: ${declaration}`, () => {
      const { analysis, position, text } = analyzeMarked([
        'class GCPushButton {};',
        declaration,
        `void main() { GCPushButton button; button.|${expression}; }`
      ].join('\n'));
      const input = { analysis, position, workspaceIndex: createWorkspaceIndex() };
      assert.strictEqual(getHover(input), null);
      assert.deepStrictEqual(getDefinitions(input), []);
      assert.ok(!getCompletions({ ...input, text }).some(item => item.name === name));
    });
  }

  test('included enum members keep their scope inside an anonymous GUI part', () => {
    const type = 'GCLabel';
    const name = 'MD_StartValue';
    const directory = createTempDir();
    const header = `enum { ${name} };`;
    const headerPath = path.join(directory, 'messages.hh');
    fs.writeFileSync(headerPath, header);
    const text = [
      '#include "messages.hh"',
      'class AdcDlg : public GCDialog {',
      `  ${type} { OnCreate() { int message = ${name}; } };`,
      '};'
    ].join('\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const workspaceIndex = createWorkspaceIndex();
    const analysis = workspaceIndex.indexOpenDocument({ uri, version: 1, text });
    const position = positionFromOffset(text, text.indexOf(name));
    const input = { analysis, position, workspaceIndex };
    const declaration = workspaceIndex.findVisibleDeclarations(uri, name)[0];
    assert.strictEqual(declaration.kind, 'enumMember');
    assert.strictEqual(declaration.containerName, undefined);
    assert.strictEqual(getHover(input)?.plainText.split('\n')[0], `enum ${name}`);
    const reference = analysis.references.find(item => item.name === name)!;
    assert.strictEqual(resolveImplicitGuiReference(input, reference), undefined);
    assert.deepStrictEqual(getDefinitions(input), [{
      uri: pathToFileURL(headerPath).toString(),
      range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 + name.length } }
    }]);
    assert.ok(collectSemanticTokens(analysis, workspaceIndex).some(token =>
      token.range.start.line === position.line && token.range.start.character === position.character && token.tokenType === 'enumMember'));
  });

  test('inherited inline methods share definition, hover, signature and completion', () => {
    const { analysis, position, text } = analyzeMarked([
      'class GCWidget { void SetValue(int value); };',
      'class GCLabel : public GCWidget {};',
      'class AdcDlg : public GCDialog {',
      '  GCLabel { OnCreate() { |SetValue(1); } };',
      '};'
    ].join('\n'));
    const input = { analysis, position, workspaceIndex: createWorkspaceIndex() };
    assert.ok(getHover(input)?.plainText.includes('GCWidget::SetValue'));
    assert.deepStrictEqual(getDefinitions(input).map(location => location.range.start), [{ line: 0, character: 22 }]);
    assert.ok(getCompletions({ ...input, text, position: { ...position, character: position.character + 1 } }).some(item => item.name === 'SetValue' && item.detail?.includes('GCWidget::SetValue')));
    const signature = getSignatureHelp({ ...input, text, position: { ...position, character: position.character + 9 } });
    assert.strictEqual(signature?.signatures[0].parameters[0].label, 'int value');
  });

  test('a local variable shadows an implicit GUI member across features', () => {
    const { analysis, position, text } = analyzeMarked([
      'class GCLabel { string text; };',
      'class AdcDlg : public GCDialog {',
      '  GCLabel { OnCreate() { int text; |text = 1; } };',
      '};'
    ].join('\n'));
    const input = { analysis, position, workspaceIndex: createWorkspaceIndex() };
    assert.strictEqual(getHover(input)?.plainText, 'int text');
    assert.deepStrictEqual(getDefinitions(input).map(location => location.range.start), [
      positionFromOffset(text, text.indexOf('int text') + 4)
    ]);
    const completion = getCompletions({ ...input, text, position: { ...position, character: position.character + 1 } })
      .find(item => item.name === 'text');
    assert.ok(completion?.detail?.startsWith('int '), completion?.detail);
    const references = getReferences({ ...input, includeDeclaration: false });
    assert.deepStrictEqual(references.map(location => location.range.start), [position]);
  });

  test('nested member paths resolve beyond a named GUI part', () => {
    const { analysis, position, text } = analyzeMarked([
      'class Payload { int value; };',
      'class GCPushButton { Payload payload; };',
      'class AdcDlg : public GCDialog {',
      '  GCPushButton button;',
      '  void OnCreate() { button.payload.|value = 1; }',
      '};'
    ].join('\n'));
    const input = { analysis, position, workspaceIndex: createWorkspaceIndex() };
    assert.ok(getHover(input)?.plainText.includes('Payload::value'));
    assert.deepStrictEqual(getDefinitions(input).map(location => location.range.start), [
      positionFromOffset(text, text.indexOf('int value') + 4)
    ]);
  });

  test('colorization resolves GUI receivers declared in an included document', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'dialog.h'), [
      'void text();',
      'class GCLabel { string text; };',
      'class AdcDlg : public GCDialog { GCLabel label; };'
    ].join('\n'));
    const text = '#include "dialog.h"\nvoid AdcDlg::label::OnCreate() { text = "x"; }';
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const workspaceIndex = createWorkspaceIndex();
    const analysis = workspaceIndex.indexOpenDocument({ uri, version: 1, text });
    const position = positionFromOffset(text, text.indexOf('text ='));
    const input = { analysis, position, workspaceIndex };
    assert.ok(getHover(input)?.plainText.includes('GCLabel::text'));
    assert.deepStrictEqual(getDefinitions(input).map(location => location.range.start), [{ line: 1, character: 23 }]);
    let documentLookups = 0;
    const tokens = collectSemanticTokens(analysis, {
      listVisibleDeclarations: workspaceIndex.listVisibleDeclarations.bind(workspaceIndex),
      findGuiClass: workspaceIndex.findGuiClass.bind(workspaceIndex),
      listVisibleDocuments: uri => { documentLookups++; return workspaceIndex.listVisibleDocuments(uri); }
    });
    assert.ok(tokens.some(token =>
      token.range.start.line === position.line && token.range.start.character === position.character && token.tokenType === 'variable'));
    assert.strictEqual(documentLookups, 1, 'A token request should load dependency documents once');
  });

  test('features prefer the implicit method over an unrelated visible function', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'globals.h'), 'void SetValue(int a, int b);');
    const text = [
      '#include "globals.h"',
      'class GCWidget { void SetValue(int value); };',
      'class GCLabel : public GCWidget {};',
      'class AdcDlg : public GCDialog {',
      '  GCLabel { OnCreate() { SetValue(1, 2); } };',
      '};'
    ].join('\n');
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const workspaceIndex = createWorkspaceIndex();
    const analysis = workspaceIndex.indexOpenDocument({ uri, version: 1, text });
    const position = positionFromOffset(text, text.lastIndexOf('SetValue'));
    const input = { analysis, position, workspaceIndex };
    assert.ok(getHover(input)?.plainText.includes('GCWidget::SetValue'));
    assert.deepStrictEqual(getDefinitions(input).map(location => location.range.start), [{ line: 1, character: 22 }]);
    const completion = getCompletions({ ...input, text, position: { ...position, character: position.character + 1 } })
      .find(item => item.name === 'SetValue');
    assert.ok(completion?.detail?.includes('GCWidget::SetValue'), completion?.detail);
    assert.ok(collectSemanticDiagnostics(input).some(diagnostic =>
      diagnostic.range.start.line === position.line
      && diagnostic.range.start.character === position.character
      && diagnostic.message.includes('expects 1 argument')));
  });

  test('recovered static members are not attributed to an earlier unrelated class', () => {
    const fixture = recoveredStaticMemberFixture();
    const input = { ...fixture, position: { line: 0, character: 22 } };
    assert.deepStrictEqual(getDefinitions(input), []);
    assert.strictEqual(getHover(input), null);
    const declarations = fixture.workspaceIndex.listVisibleDeclarations('');
    declarations.splice(1, 0, { ...declarations[0], id: 'other', name: 'OTHER',
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } },
      selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 11 } }
    });
    assert.deepStrictEqual(getDefinitions(input), []);
    assert.strictEqual(getHover(input), null);
  });

  test('GUI context lookup does not resolve receivers outside the requested method', () => {
    const { analysis, position } = analyzeMarked([
      'class AdcDlg : public GCDialog { GCLabel label; };',
      'void AdcDlg::label::OnCreate() {}',
      'void main() { | }'
    ].join('\n'));
    const workspaceIndex = createWorkspaceIndex();
    let documentLookups = 0;
    const input = { analysis, position, workspaceIndex: {
      listVisibleDocuments: (uri: string) => { documentLookups++; return workspaceIndex.listVisibleDocuments(uri); }
    } };
    const context = findEnclosingGuiMethodContext(input);
    assert.strictEqual(context, undefined);
    assert.strictEqual(documentLookups, 0, 'Out-of-range GUI methods must not scan dependency documents');
    assert.strictEqual(findEnclosingGuiMethodContext({ ...input, position: { line: 1, character: 28 } })?.receiverTypeName, 'GCLabel');
    assert.strictEqual(documentLookups, 0, 'Locally resolved GUI receivers must not scan dependency documents');
  });
});
