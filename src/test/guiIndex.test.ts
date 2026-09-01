import * as assert from 'assert';
import { createAxelParser } from '../analyzer/axelParser';
import { buildGuiIndex } from '../analyzer/guiIndex';

suite('buildGuiIndex', () => {
  const parser = createAxelParser();
  const uri = 'file:///main.axl';

  test('classifies direct GUI class bases', () => {
    const index = buildGuiIndex(parser.parse([
      'class MyDialog : public GCDialog {};',
      'class MyFileDialog : public GCFileDialog {};',
      'class MyWidget : public GCWidget {};',
      'class MyLayout : public GCVBoxLayout {};'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.map((guiClass) => ({
        name: guiClass.name,
        baseName: guiClass.baseName,
        kind: guiClass.kind
      })),
      [
        { name: 'MyDialog', baseName: 'GCDialog', kind: 'dialog' },
        { name: 'MyFileDialog', baseName: 'GCFileDialog', kind: 'fileDialog' },
        { name: 'MyWidget', baseName: 'GCWidget', kind: 'widget' },
        { name: 'MyLayout', baseName: 'GCVBoxLayout', kind: 'guiPart' }
      ]
    );
  });

  test('extracts named and anonymous GUI parts recursively', () => {
    const index = buildGuiIndex(parser.parse([
      'class MyDialog : public GCDialog {',
      '  GCVBoxLayout {',
      '    GCGroupBox group {',
      '      GCText input;',
      '      GCPushButton button { OnPush() {} };',
      '    };',
      '  };',
      '};'
    ].join('\n')).rootNode, uri);

    assert.strictEqual(index.length, 1);
    assert.deepStrictEqual(summarizeParts(index[0].parts), [
      {
        name: undefined,
        typeName: 'GCVBoxLayout',
        path: [],
        anonymous: true,
        methods: [],
        parts: [
          {
            name: 'group',
            typeName: 'GCGroupBox',
            path: ['group'],
            anonymous: false,
            methods: [],
            parts: [
              {
                name: 'input',
                typeName: 'GCText',
                path: ['group', 'input'],
                anonymous: false,
                methods: [],
                parts: []
              },
              {
                name: 'button',
                typeName: 'GCPushButton',
                path: ['group', 'button'],
                anonymous: false,
                methods: [{
                  name: 'OnPush',
                  receiverPath: ['group', 'button', 'OnPush'],
                  event: true
                }],
                parts: []
              }
            ]
          }
        ]
      }
    ]);
  });

  test('normalizes external GUI event receiver paths', () => {
    const index = buildGuiIndex(parser.parse([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCText input; };',
      '};',
      'void MyDialog::group.input::OnChanged() {}',
      'int MyDialog::helper() {}'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index[0].methods.map((method) => ({
        name: method.name,
        receiverPath: method.receiverPath,
        event: method.event
      })),
      [
        { name: 'OnChanged', receiverPath: ['MyDialog', 'group', 'input', 'OnChanged'], event: true },
        { name: 'helper', receiverPath: ['MyDialog', 'helper'], event: false }
      ]
    );
  });

  test('requires an alphabetic or underscore character after On for GUI events', () => {
    const index = buildGuiIndex(parser.parse([
      'class MyDialog : public GCDialog {};',
      'void MyDialog::On$Invalid() {}',
      'void MyDialog::On_Valid() {}'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index[0].methods.map((method) => ({
        name: method.name,
        event: method.event
      })),
      [
        { name: 'On$Invalid', event: false },
        { name: 'On_Valid', event: true }
      ]
    );
  });

  test('uses known GUI class names to classify reusable part instances', () => {
    const index = buildGuiIndex(
      parser.parse('class MyDialog : public GCDialog { CustomWidget custom; };').rootNode,
      uri,
      new Set(['CustomWidget'])
    );

    assert.deepStrictEqual(index[0].parts.map((part) => ({
      name: part.name,
      typeName: part.typeName,
      path: part.path,
      anonymous: part.anonymous
    })), [{
      name: 'custom',
      typeName: 'CustomWidget',
      path: ['custom'],
      anonymous: false
    }]);
  });

  test('does not throw for malformed GUI classes', () => {
    const index = buildGuiIndex(
      parser.parse('class Broken : public GCDialog { GCVBoxLayout { GCText recovered; ').rootNode,
      uri
    );

    assert.deepStrictEqual(index, []);
  });
});

function summarizeParts(parts: ReturnType<typeof buildGuiIndex>[number]['parts']): unknown[] {
  return parts.map((part) => ({
    name: part.name,
    typeName: part.typeName,
    path: part.path,
    anonymous: part.anonymous,
    methods: part.methods.map((method) => ({
      name: method.name,
      receiverPath: method.receiverPath,
      event: method.event
    })),
    parts: summarizeParts(part.parts)
  }));
}
