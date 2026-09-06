import * as assert from 'assert';
import type { AnalysisHover } from '../../types/analysis';
export function assertExternalHover(hover: AnalysisHover | null, detail: string, filePath: string): void {
  assert.ok(hover);
  assert.strictEqual(hover.plainText, `${detail}\ndefined in ${filePath}`);
  assert.ok(hover.markdown.startsWith(`\`\`\`axel\n${detail}\n\`\`\`\n\ndefined in `));
}