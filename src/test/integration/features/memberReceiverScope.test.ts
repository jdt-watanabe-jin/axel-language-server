import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
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
  test('uses the owning class field instead of an unrelated header parameter', () => {
    assert.deepStrictEqual(check('socket.SetDialog(this); socket.Close();'), []);
  });
  test('class fields take precedence over same-named global variables', () => {
    assert.deepStrictEqual(check('socket.SetDialog(this);', 'int socket;'), []);
  });
  test('local variables still shadow class fields', () => {
    const diagnostics = check('int socket; socket.SetDialog(this);');
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'SetDialog'."));
  });
  test('reports missing members on a correctly resolved receiver', () => {
    const diagnostics = check('socket.Missing();');
    assert.ok(diagnostics.some(d => d.message === "Unknown identifier 'Missing'."));
  });
});
