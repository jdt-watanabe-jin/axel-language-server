import * as path from 'path';

export function fixturePath(name: string) {
  return path.resolve(__dirname, '../../../src/test/integration/fixtures', name);
}
