import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { performance } from 'perf_hooks';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { FileRenameIndex } from '../../analyzer/fileOperations';
import { useWorkspaceFixtures } from '../support/workspace';

const { createTempDir } = useWorkspaceFixtures();
suite('File operation performance', function () {
  this.timeout(10000);
  test('yields during large scans and returns no partial edits on cancellation or deadline', async () => {
    const root = createTempDir();
    const uri = (name: string) => pathToFileURL(path.join(root, name)).toString();
    fs.writeFileSync(path.join(root, 'api.h'), '');
    for (let i = 0; i < 300; i++) { fs.writeFileSync(path.join(root, `${i}.axl`), '#include "api.h"\n'); }
    const logs: string[] = [];
    const index = new FileRenameIndex(() => [], message => logs.push(message));
    index.configure([uri('')], {});
    const moves = [{ oldUri: uri('api.h'), newUri: uri('new.h') }];
    let ticks = 0;
    const heartbeat = setInterval(() => { ticks++; }, 1);
    try {
      const start = performance.now();
      const edits = await index.getEdits(moves, CancellationToken.None);
      assert.strictEqual(edits?.documentChanges?.length, 300, logs.join('\n'));
      assert.ok(ticks > 0, 'transport work must run during scanning');
      assert.strictEqual(await index.getEdits(moves, CancellationToken.None, 1), null);
      const source = new CancellationTokenSource();
      const pending = index.getEdits(moves, source.token);
      setImmediate(() => source.cancel());
      await assert.rejects(pending, { code: LSPErrorCodes.RequestCancelled });
      source.dispose();
      console.log(`Include rename: 300 sources, scan/edit/deadline/cancel=${(performance.now() - start).toFixed(0)}ms`);
    } finally { clearInterval(heartbeat); }
  });
});
