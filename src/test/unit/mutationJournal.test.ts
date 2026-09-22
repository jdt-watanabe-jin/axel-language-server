import * as assert from 'assert';
import { JournalMap, JournalSet, MutationJournal } from '../../util/mutationJournal';
suite('Mutation journal', () => {
  test('restores original values and set members after repeated writes, deletion and clear', () => {
    let active: MutationJournal | undefined = undefined;
    const map = new JournalMap<string, number | undefined>(() => active);
    const set = new JournalSet<string>(() => active);
    map.set('a', 1); map.set('undefined', undefined); set.add('a'); set.add('b');
    active = new MutationJournal();
    map.set('a', 2); map.set('a', 3); map.delete('undefined'); map.set('new', 4);
    set.delete('a'); set.add('c'); set.clear(); set.add('d'); map.clear();
    active.rollback();
    assert.deepStrictEqual([...map], [['a',1],['undefined',undefined]]);
    assert.deepStrictEqual([...set].sort(), ['a','b']);
  });
  test('commit releases undo state and set updates do not enumerate existing members', () => {
    let active: MutationJournal | undefined = undefined;
    const set = new JournalSet<number>(() => active);
    for(let i=0;i<10000;i++) { set.add(i); }
    let reads=0;
    const iterator=set[Symbol.iterator].bind(set);
    set[Symbol.iterator]=function*(){ for(const value of iterator()) { reads++; yield value; } return undefined; };
    active = new MutationJournal();
    set.add(10000); set.delete(5);
    active.clear(); active.rollback();
    assert.ok(set.has(10000)); assert.ok(!set.has(5)); assert.strictEqual(reads, 0);
  });
});
