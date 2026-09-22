/** Key/value undo journal. Values must be replaced, except for tracked JournalSet memberships.
 * Map insertion order is not a transaction contract; graph traversal order lives
 * in immutable forward-graph Set values. Only writes inside run() belong to this journal. */
export class MutationJournal {
  private readonly setEntries = new Map<Set<unknown>, Map<unknown, boolean>>();
  recordSet<T>(set: Set<T>, value: T): void {
    let entries = this.setEntries.get(set);
    if (!entries) { entries = new Map(); this.setEntries.set(set, entries); }
    if (!entries.has(value)) { entries.set(value, set.has(value)); }
  }
  private readonly entries = new Map<Map<unknown, unknown>, Map<unknown, {present: boolean; value: unknown}>>();
  record<K, V>(map: Map<K, V>, key: K): void {
    let entries = this.entries.get(map);
    if (!entries) { entries = new Map(); this.entries.set(map, entries); }
    if (!entries.has(key)) { entries.set(key, {present: map.has(key), value: map.get(key)}); }
  }
  keys<K, V>(map: Map<K, V>): K[] { return [...(this.entries.get(map)?.keys() ?? [])] as K[]; }
  rollback(): void {
    for (const [map, entries] of this.entries) {
      for (const [key, before] of entries) {
        if (before.present) { Map.prototype.set.call(map, key, before.value); }
        else { Map.prototype.delete.call(map, key); }
      }
    }
    for (const [set, entries] of this.setEntries) {
      for (const [value, present] of entries) {
        if (present) { Set.prototype.add.call(set, value); } else { Set.prototype.delete.call(set, value); }
      }
    }
    this.clear();
  }
  clear(): void { this.entries.clear(); this.setEntries.clear(); }
}
export class JournalMap<K, V> extends Map<K, V> {
  constructor(private readonly active: () => MutationJournal | undefined) { super(); }
  override set(key: K, value: V): this {
    if (!this.has(key) || this.get(key) !== value) { this.active()?.record(this, key); }
    return super.set(key, value);
  }
  override delete(key: K): boolean {
    if (this.has(key)) { this.active()?.record(this, key); }
    return super.delete(key);
  }
  override clear(): void {
    const journal = this.active();
    if (journal) { for (const key of this.keys()) { journal.record(this, key); } }
    super.clear();
  }
}
export interface AnalysisTransaction {
  (): void;
  run<T>(work: () => T): T;
  commit(): void;
}

/** Reverse edges and include candidates record changed members, never copy fan-in sets. */
export class JournalSet<T> extends Set<T> {
  constructor(private readonly active: () => MutationJournal | undefined) { super(); }
  override add(value: T): this {
    if (!this.has(value)) { this.active()?.recordSet(this, value); }
    return super.add(value);
  }
  override delete(value: T): boolean {
    if (this.has(value)) { this.active()?.recordSet(this, value); }
    return super.delete(value);
  }
  override clear(): void {
    const journal = this.active();
    if (journal) { for (const value of this) { journal.recordSet(this, value); } }
    super.clear();
  }
}
