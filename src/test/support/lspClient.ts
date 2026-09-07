import { spawn } from 'child_process';
import * as path from 'path';
import { createProtocolConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver/node';

// Real stdio transport and production entry point; no analyzer or handler doubles.
export function startLspServer() {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../server.js'), '--stdio'], {
    windowsHide: true,
    env: { ...process.env, APP_AXELPATH: '', SXM_FORCED_INCLUDE_FILES: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  // Keep startup errors observed even before the first request.
  void closed.catch(() => undefined);
  const connection = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  connection.onRequest('workspace/semanticTokens/refresh', () => null);
  connection.onRequest('workspace/diagnostic/refresh', () => null);
  connection.listen();
  async function deadline<T>(work: Promise<T>, operation: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(operation + ' timed out. ' + stderr)), 5_000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    request<T>(method: string, params?: object) {
      return deadline(connection.sendRequest<T>(method, params), method);
    },
    notify(method: string, params?: object) {
      return connection.sendNotification(method, params);
    },
    async stop() {
      try {
        await deadline(connection.sendRequest('shutdown'), 'shutdown');
        await connection.sendNotification('exit');
        const code = await deadline(closed, 'exit');
        if (code !== 0) { throw new Error('Server exited with ' + code + ': ' + stderr); }
      } finally {
        connection.dispose();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await deadline(closed, 'forced cleanup');
        }
      }
    }
  };
}
