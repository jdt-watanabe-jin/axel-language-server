import * as assert from 'assert';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Visible context reuse', () => {
  const { createWorkspaceIndex } = useWorkspaceFixtures();
  test('does not recollect declarations for repeated token requests', () => {
    const index = createWorkspaceIndex();
    const input = { uri: 'file:///visible.axl', version: 1, text: 'int value; void main(){ value++; }' };
    const analysis = index.indexOpenDocument(input);
    const tokens = index.getSemanticTokens(analysis);
    const declarations = analysis.declarations;
    let reads = 0;
    Object.defineProperty(analysis, 'declarations', { configurable: true, get() { reads++; return declarations; } });
    for (let i = 0; i < 20; i++) { assert.strictEqual(index.getSemanticTokens(analysis), tokens); }
    assert.strictEqual(reads, 0);
    const changed = index.indexOpenDocument({ ...input, version: 2, text: 'string replacement;' });
    assert.notStrictEqual(index.getSemanticTokens(changed), tokens);
    assert.deepStrictEqual(changed.declarations.map(d => d.name), ['replacement']);
  });
});
