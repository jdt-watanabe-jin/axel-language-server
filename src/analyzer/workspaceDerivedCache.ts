/** Invalidates derived values without owning authoritative documents or dependency edges. */
export class WorkspaceDerivedCache {
  constructor(private readonly caches: readonly Map<string, unknown>[]) {}

  invalidate(uris?: Iterable<string>): void {
    if (uris === undefined) {
      for (const cache of this.caches) { cache.clear(); }
      return;
    }
    const changed = [...uris];
    for (const cache of this.caches) {
      for (const uri of changed) { cache.delete(uri); }
    }
  }
}
