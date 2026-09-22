import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getHover } from '../../../analyzer/hover';
import { getDefinitions } from '../../../analyzer/navigation';
import { positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('Member receiver scope', () => {
  const fixtures = useWorkspaceFixtures();
  const classes = `class Socket {public: int data; void Close() {}}
    ; class Dialog {
      class MySocket : public Socket {public: void SetDialog(Dialog *dlg) {}};
      MySocket socket;
    };`;
  function check(body: string, globals = '') {
    const root = fixtures.createTempDir();
    const header = path.join(root, 'api.h');
    fs.writeFileSync(header, 'void unrelated(int socket) {}');
    const index = fixtures.createWorkspaceIndex({forcedIncludeFiles:[header]});
    return index.analyzeDocument({uri:'file:///z%3A/receiver.axl',version:1,
      text: classes + globals + ` void Dialog::run() { ${body} }`}).diagnostics;
  }
  test('class fields take precedence over same-named global variables', () => {
    assert.deepStrictEqual(check('socket.SetDialog(this);', 'int socket;'), []);
  });
  test('local variables still shadow class fields', () => {
    const diagnostics = check('int socket; socket.SetDialog(this);');
    assert.ok(diagnostics.some(d => d.message === "Member 'SetDialog' was not found on type 'int'."));
  });
  test('reports missing members on a correctly resolved receiver', () => {
    const diagnostics = check('socket.Missing();');
    assert.ok(diagnostics.some(d => d.message === "Member 'Missing' was not found on type 'MySocket'."));
  });
  test('hovers and navigates to direct and inherited receiver methods despite unrelated parameters', () => {
    const root = fixtures.createTempDir();
    const header = path.join(root, 'api.h');
    fs.writeFileSync(header, 'void unrelated(int socket) {}');
    const index = fixtures.createWorkspaceIndex({forcedIncludeFiles:[header]});
    const text = classes + ' void Dialog::run() { socket.SetDialog(this); socket.Close(); }';
    const analysis = index.analyzeDocument({uri:'file:///z%3A/receiver.axl',version:1,text});
    assert.deepStrictEqual(analysis.diagnostics, []);
    for (const [name, signature] of [
      ['SetDialog', 'void MySocket::SetDialog(Dialog *dlg)'],
      ['Close', 'void Socket::Close()']
    ]) {
      const input = {analysis,position:positionFromOffset(text,text.lastIndexOf(name)+1),workspaceIndex:index};
      const hover = getHover(input);
      assert.ok(hover?.markdown.includes(signature), JSON.stringify(hover));
      const target = analysis.declarations.find(d => d.name === name)!;
      assert.deepStrictEqual(getDefinitions(input), [{uri:target.uri,range:target.selectionRange}]);
    }
  });
});
