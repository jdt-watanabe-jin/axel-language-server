import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceIndex, type WorkspaceIndexOptions } from '../../analyzer/workspaceIndex';

// Call once per test module. Every test gets fresh instances; only cleanup is shared.
export function useWorkspaceFixtures() {
  const directories = new Set<string>();
  const indexes = new Set<WorkspaceIndex>();
  teardown(async () => {
    try {
      await Promise.all([...indexes].map(index => index.waitForBackgroundIndexing()));
    } finally {
      indexes.clear();
      for (const directory of directories) {
        const relative = path.relative(os.tmpdir(), directory);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          assert.fail('Refusing to remove a directory outside the test temp root');
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
      directories.clear();
    }
  });
  return {
    createTempDir() {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-test-'));
      directories.add(directory);
      return directory;
    },
    createWorkspaceIndex(options?: WorkspaceIndexOptions) {
      const index = new WorkspaceIndex(options);
      indexes.add(index);
      return index;
    }
  };
}
