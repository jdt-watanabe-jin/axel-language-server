import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Login LSP', function () {
  this.timeout(30_000);
  const { createTempDir } = useWorkspaceFixtures();
  test('publishes external dependencies, resolves globals and refreshes after file changes', async () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'bin'));
    const login = path.join(root, 'bin/_login.axl');
    const header = path.join(root, 'bin/shared.h');
    fs.writeFileSync(login, '#include "shared.h"\nvoid main() {}');
    fs.writeFileSync(header, 'int shared;');
    const uri = pathToFileURL(path.join(root, 'consumer.axl')).toString();
    const headerUri = pathToFileURL(header).toString();
    const server = startLspServer();
    const logs: string[] = [];
    server.onNotification('window/logMessage', (event: { message: string }) => logs.push(event.message));
    const notifications: { generation: number; uris: string[] }[] = [];
    let dependenciesPublished: () => void = () => undefined;
    const published = new Promise<void>(resolve => { dependenciesPublished = resolve; });
    server.onNotification('axel/loginDependencies', (event: { generation: number; uris: string[] }) => {
      notifications.push(event);
      if (event.uris.includes(headerUri)) { dependenciesPublished(); }
    });
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: {}, initializationOptions: { sxmHome: root, forcedIncludeFiles: [header] } });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'axel', text: 'void main() { shared; }' } });
      const position = { textDocument: { uri }, position: { line: 0, character: 15 } };
      const definitions = await server.request<{ uri: string }[]>('textDocument/definition', position);
      assert.strictEqual(definitions[0]?.uri, headerUri);
      await published;
      assert.ok(notifications.some(n => n.uris.includes(headerUri)), JSON.stringify(notifications));
      // An immediate request in the consumer must flush pending unsaved header edits.
      await server.notify('textDocument/didOpen', { textDocument: {
        uri: headerUri, version: 1, languageId: 'axel', text: 'int shared;'
      } });
      for (const [version, type] of [[2, 'double'], [3, 'string']] as const) {
        await server.notify('textDocument/didChange', {
          textDocument: { uri: headerUri, version }, contentChanges: [{ text: `${type} shared;` }]
        });
      }
      const hover = await server.request('textDocument/hover', position);
      assert.ok(JSON.stringify(hover).includes('string shared'), JSON.stringify(hover));
      await server.notify('textDocument/didClose', { textDocument: { uri: headerUri } });
      fs.writeFileSync(header, 'int replaced;');
      await server.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: headerUri, type: 2 }] });
      assert.deepStrictEqual(await server.request('textDocument/definition', position), []);
      await server.notify('workspace/didChangeConfiguration', { settings: { sxmHome: '' } });
      await server.request('textDocument/hover', position);
      assert.ok(notifications.some(n => n.uris.length === 0));
      assert.ok(!logs.some(log => /operation=(document\.analyze|workspace\.)/.test(log)), logs.join('\n'));
    } finally { await server.stop(); }
  });
});
