import type { CancellationToken } from 'vscode-languageserver/node';
import { ProjectScope } from '../projectScope';
export { filePath, fileIdentity, fileUri, insideRoot, excluded, isAxelFile } from '../projectScope';

export async function collectWorkspaceSymbolFiles(roots: readonly string[], exclude: readonly string[],
  token: CancellationToken, logError: (message: string) => void): Promise<Map<string, string>> {
  const scope = new ProjectScope(logError);
  scope.setRoots(roots); scope.configure({ include: ['**/*'], exclude: [...exclude] });
  return scope.collect(token);
}
