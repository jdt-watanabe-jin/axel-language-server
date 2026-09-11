import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { DocumentDiagnosticReport, Hover } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP target platform', function () {
  this.timeout(20_000);
  test('refreshes included declarations and hover after a configuration notification', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-platform-'));
    const header = path.join(directory, 'platform.h');
    fs.writeFileSync(header, '#if __OS_WINDOWS__\nint windowsOnly;\n#else\nint unixOnly;\n#endif\n');
    const server = startLspServer();
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const textDocument = { uri };
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: {}, initializationOptions: { targetPlatform: 'hpux-hppa32' } });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text: '#include "platform.h"\nvoid main(){ windowsOnly; unixOnly; }\nint bits = __OS_64bit__;' } });
      for (const [targetPlatform, unknownName, bit] of [['hpux-hppa32', 'windowsOnly', 0], ['windows-x64', 'unixOnly', 1], ['linux-x86', 'windowsOnly', 0]] as const) {
        if (targetPlatform !== 'hpux-hppa32') {
          await server.notify('workspace/didChangeConfiguration', { settings: { targetPlatform } });
        }
        const report = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument });
        assert.ok(report.kind === 'full');
        assert.ok(report.items.some(item => item.message.includes(unknownName)), JSON.stringify(report));
        assert.ok(!report.items.some(item => item.message.includes(unknownName === 'windowsOnly' ? 'unixOnly' : 'windowsOnly')), JSON.stringify(report));
        const hover = await server.request<Hover>('textDocument/hover', { textDocument, position: { line: 2, character: 15 } });
        assert.ok(JSON.stringify(hover.contents).includes(`__OS_64bit__ (int)\\n${bit}`), JSON.stringify(hover));
      }
    } finally {
      await server.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});