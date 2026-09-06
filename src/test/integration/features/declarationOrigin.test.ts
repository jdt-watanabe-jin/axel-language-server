import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getCompletions } from '../../../analyzer/completion';
import { getHover } from '../../../analyzer/hover';
import { toLspCompletionItem } from '../../../lsp/completion';
import { toLspHover } from '../../../lsp/hover';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('included declaration origins', () => {
  for (const mode of ['include', 'nested include', 'forced include']) {
    for (const usage of ['shared', 'value.member', 'TWICE(2)', 'Dialog dialog', 'dialog.input']) {
      test(`${mode} displays the defining file for ${usage}`, () => {
        const directory = createTempDir();
        const header = path.join(directory, 'shared [header].h');
        try {
          fs.writeFileSync(header, [
            '// Shared documentation.',
            'int shared;',
            'class Widget { public: int member; };',
            'class Dialog : public GCDialog { GCText input; };',
            '#define TWICE(x) x + x'
          ].join('\n'));
          fs.writeFileSync(path.join(directory, 'wrapper.h'), '#include "shared [header].h"');
          const prefix = mode === 'forced include' ? '' : mode === 'include'
            ? '#include "shared [header].h"\n' : '#include "wrapper.h"\n';
          const text = `${prefix}void main() { Widget value; Dialog dialog;\n${usage}; }`;
          const index = createWorkspaceIndex({ forcedIncludeFiles: mode === 'forced include' ? [header] : [] });
          const analysis = index.indexOpenDocument({
            uri: pathToFileURL(path.join(directory, 'main.axl')).toString(), version: 1, text
          });
          const offset = text.lastIndexOf(usage) + (usage.includes('.') ? usage.indexOf('.') + 1 : 0);
          const before = text.slice(0, offset).split('\n');
          const position = { line: before.length - 1, character: before.at(-1)!.length + (usage === 'Dialog dialog' ? 0 : 1) };
          const hover = getHover({ analysis, position, workspaceIndex: index });
          assert.ok(hover?.plainText.includes(`defined in ${header}`), hover?.plainText);
          assert.ok(hover?.markdown.includes('defined in '));
          assert.ok(hover?.markdown.includes('shared \\[header\\]'), hover?.markdown);
          if (process.platform === 'win32') {
            assert.ok(hover?.markdown.includes('\\\\'), hover?.markdown);
          }
          assert.ok(JSON.stringify(toLspHover(hover!)).includes('defined in '));
          const completionPosition = usage === 'Dialog dialog'
            ? { ...position, character: position.character + 'Dialog '.length } : position;
          const completion = getCompletions({ analysis, text, position: completionPosition, workspaceIndex: index })
            .find((item) => item.name === (usage === 'value.member' ? 'member' : usage === 'TWICE(2)' ? 'TWICE'
              : usage === 'Dialog dialog' ? 'Dialog' : usage === 'dialog.input' ? 'input' : 'shared'));
          assert.ok(completion?.documentation?.includes(`defined in ${header}`));
          assert.strictEqual(toLspCompletionItem(completion!).documentation, completion!.documentation);
          if (usage === 'shared') {
            assert.ok(hover?.plainText.includes('Shared documentation.'));
            assert.ok(completion?.documentation?.includes('Shared documentation.'));
          }
          if (usage === 'TWICE(2)') {
            assert.ok(hover?.plainText.includes('Expansion:\n2 + 2'));
          }
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }

  test('a local declaration shadowing an include has no external origin', () => {
    const directory = createTempDir();
    try {
      const header = path.join(directory, 'shared.h');
      fs.writeFileSync(header, 'int shared;');
      const text = '#include "shared.h"\nvoid main() { int shared;\nshared; }';
      const index = createWorkspaceIndex();
      const analysis = index.indexOpenDocument({
        uri: pathToFileURL(path.join(directory, 'main.axl')).toString(), version: 1, text
      });
      const position = { line: 2, character: 1 };
      const hover = getHover({ analysis, position, workspaceIndex: index });
      assert.strictEqual(hover?.plainText, 'int shared');
      const completion = getCompletions({ analysis, text, position, workspaceIndex: index })
        .find((item) => item.name === 'shared');
      assert.ok(completion);
      assert.ok(!completion.documentation?.includes('defined in '));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
