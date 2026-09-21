import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import { cachedSyntaxNode } from '../../../analyzer/cachedSyntaxNode';
import { getSourceSyntaxFacts } from '../../../analyzer/sourceSyntaxFacts';
import { buildTypeSnapshot } from '../../../analyzer/typeChecking/syntax';

suite('Source syntax facts', () => {
  test('shares completed facts but isolates source trees and URIs', () => {
    const parser = createAxelParser();
    const a = cachedSyntaxNode(parser.parse('#define VALUE 1\nint a;').rootNode);
    const b = cachedSyntaxNode(parser.parse('#define VALUE 2\nint b;').rootNode);
    const facts = getSourceSyntaxFacts(a, 'file:///a.axl');
    assert.strictEqual(facts.macros, getSourceSyntaxFacts(a, 'file:///a.axl').macros);
    assert.strictEqual(facts.system, getSourceSyntaxFacts(a, 'file:///a.axl').system);
    assert.strictEqual(facts.macros[0].replacementText, '1');
    assert.strictEqual(getSourceSyntaxFacts(b, 'file:///a.axl').macros[0].replacementText, '2');
    assert.notStrictEqual(facts, getSourceSyntaxFacts(a, 'file:///other.axl'));
    assert.strictEqual(facts.typeSnapshot([]), facts.typeSnapshot([]));
    assert.deepStrictEqual(facts.typeSnapshot([]), buildTypeSnapshot(a, 'file:///a.axl'));
  });
  test('does not share snapshots for different recovery nodes at the same range', () => {
    const root = cachedSyntaxNode(createAxelParser().parse('int value;').rootNode);
    const uri = 'file:///a.axl';
    const facts = getSourceSyntaxFacts(root, uri);
    const plain = buildTypeSnapshot(root, uri);
    const first = { ...plain.root, kind: 'first' };
    const second = { ...first, kind: 'second' };
    assert.strictEqual(facts.typeSnapshot([first]).root.kind, 'first');
    const changed = facts.typeSnapshot([second]);
    assert.strictEqual(changed.root.kind, 'second');
    assert.strictEqual(facts.typeSnapshot([second]), changed);
    assert.deepStrictEqual(facts.typeSnapshot([]), plain);
  });
});
