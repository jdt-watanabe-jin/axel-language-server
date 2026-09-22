# Language server performance

## Architecture and cost centres

The extension delegates analysis over LSP to this repository; syntax is owned by
tree-sitter-axel. No parser grammar or editor setting changes are required for the
optimizations described here.

1. `server.ts` creates `TextDocuments`, `WorkspaceIndex` and the LSP adapters.
   `registerHandlers.ts` manages configuration, document revisions, request
   cancellation, refreshes and queued document changes.
2. `WorkspaceIndex` coordinates open/disk documents, forced includes, startup
   login scope, dependency graphs, foreground work and cooperative background work.
   Generators in `analysisSteps.ts` share the synchronous and asynchronous pipeline.
   Request mutation journals prevent partially published analysis from surviving cancellation.
3. `DocumentAnalyzer` parses through native Tree-sitter, evaluates preprocessing,
   reparses conditional/macro source when necessary, builds symbols/scopes/GUI
   data and a type snapshot, and extracts documentation. Syntax-only outline,
   folding, links and selection requests have separate paths.
4. Workspace diagnostics combine include resolution, type checking and semantic
   diagnostics. Resolution, navigation, hover, completion, tokens, hints and
   hierarchies consume these analysis generations.
5. Workspace symbols and type hierarchy maintain project indexes; call hierarchy
   builds cached graphs. File operations enumerate affected project files.
   Deferred LSP item stores are bounded; document/context lookup indexes use weak
   ownership or dependency-driven invalidation.

The portable performance suite covers startup dependencies/macros, real LSP editing
latency, call/type hierarchy, highlights, inlay hints, file operations, folding,
workspace symbols and cache reuse. These are complementary workloads, not a
single representative production project.

## Repeatable measurements

From this repository, with dependencies already installed:

```powershell
npm run benchmark -- --output before.json
# Make an optimization, then:
npm run benchmark -- --baseline before.json --output after.json
npm run test:ci
```

The benchmark command builds the current checkout, starts three Node processes
sequentially, and writes UTF-8 JSON. Use `--samples 5` for more samples.
Output files must not already exist. Comparison checks runtime/machine identity,
scenario sizes and measured result hashes. Temporary fixture paths are normalized
before hashing. Keep the fixture generator unchanged across comparisons.
Lookup hashes cover counts; they do not prove declaration identity, ordering or
all language semantics. Regression and integration tests remain necessary.

The worker measures 250, 1,000 and 4,000 declarations, parsing, document analysis,
workspace diagnostics, name/member/type lookup, hover, semantic tokens, outline,
edits and external declarations, plus macro type diagnostics. Each process is
fresh, but scenarios within it intentionally include warm reuse. For example,
the member lookup runs after name lookup has prepared the shared index; tokens
include one cold collection and 19 cached reads. `hover100` measures analyzer calls,
not JSON-RPC round trips. The existing editing latency test measures real LSP traffic.

Metrics are elapsed milliseconds, process CPU milliseconds, change in JS heap
usage during an operation, sampled RSS, result hash and final memory readings.
The runner reports medians and retains all samples. Windows CPU accounting is
coarse: a short operation can report zero. Heap delta can be negative after GC;
it is neither total allocation nor retained memory. RSS is sampled, not peak RSS.
Do not run unrelated tests/profilers concurrently.

For CPU profiling, build first and run the worker separately:

```powershell
node --expose-gc --cpu-prof --cpu-prof-dir=$env:TEMP scripts/benchmark.mjs
```

Inspect the resulting `.cpuprofile` in a compatible CPU profile viewer. Profiling
adds overhead; exclude profiled samples from before/after timing comparisons.
For actual installed SDK/startup workloads, use the configurable
[startup measurement](startup-performance.md).

To inspect old-generation retention after warming lookup caches:

```powershell
npm run build
node --expose-gc node_modules/mocha/bin/mocha.js --ui tdd out/test/performance/analysisLifetime.test.js
```

This reports post-GC heaps and weak references after twenty close/reopen cycles.
GC timing is not a CI assertion. Check trends and reachability together, and
also profile long-lived workspaces before claiming a general memory reduction.

## Lookup ownership and invalidation

- `WorkspaceIndex.listVisibleDeclarations` still returns a caller-owned copy.
  `getVisibleDeclarationSnapshot` returns a frozen, readonly array with stable
  identity until its visible dependencies change. Declaration objects themselves
  are analysis-generation data, not deeply frozen.
- Shared resolution indexes key off the local declaration array and visible
  snapshot using weak maps. Repeated requests reuse sorting/name/member indexes.
- External name lookup indexes exclude source-local declarations, preserve
  ordinary/startup precedence and return copies. They belong to the existing
  derived cache invalidation for edits, transitive includes, forced includes,
  login changes, configuration changes, cancellation rollback and document deletion.
- Type binding indexes are weakly owned by binding arrays. These arrays are
  append-only during context construction: lookup indexes only the new suffix,
  preserving declaration position, scope shadowing and last-declaration precedence.
  Any future in-place name replacement/removal must revise this invariant.
- Enclosing method/type lookup indexes only possible owners and uses the existing
  balanced range index. Method precedence, smallest containing range, source
  order on ties and exclusive range ends are preserved.

Deterministic performance tests count name/range reads through actual analyzers
and workspace adapters. They catch repeated full scans without relying only on
wall-clock thresholds. Same-version dependency changes and warmed-cache lifetime
tests exercise the new ownership boundaries.

## Startup data structures and cancellation

- Disk dependency traversal tracks completed subtrees within one analysis transaction,
  including across cooperative yields. Reuse requires the same indexed document
  identity; context/dependency invalidation removes affected entries. A subsequent
  transaction checks disk state again. Shared include graphs no longer revisit a
  completed subtree once per incoming path. This is not a persistent filesystem cache.
- Parse-local syntax views share accessors by native grammar node prototype. First
  reads memoize ordinary properties, replacing per-node Proxy handlers and Maps.
  Native methods still execute with their original receiver; child identity and
  generation-local ownership remain unchanged. Never reuse these views after a
  native tree edit. This does not introduce incremental Tree-sitter parsing.
- Macro reparsing retains the expanded semantic tree and projects its source-position
  tree only when requested. Explicit undefinition events let dependency processing
  avoid materializing that tree solely to inspect directives.
- Type snapshots stream a Tree-sitter cursor directly into generation-local TypeNode
  objects. This pass avoids materializing native child-node arrays and the parse-local
  property cache. Named children and field references share the same TypeNode.
  Traversal yields every bounded group of cursor operations. A cancelled partial
  snapshot is never cached; the cursor and unfinished result belong to the generator.
  Operator fields, missing nodes, argument delimiters and recovery replacements retain
  their existing meaning. The snapshot contains no native nodes or cursor.
- Internal macro-expanded analysis omits source-only macro highlights and documentation
  blocks. The outer analysis owns those original-source presentation values. Direct
  analysis with expansion disabled still builds presentation metadata. The analysis
  cache key includes this mode, so semantic-only and source results cannot alias.
- Login exports use URI/name binding buckets and a set of global class names instead
  of cross-products. Bucket order and source-range selection preserve shadowing.
- Cancellation interrupts waiting for asynchronous read/stat operations, closes the
  generator and rolls back before releasing the serialized analysis queue. The OS
  operation may finish later. AnalysisOperation implementations must capture results
  locally and publish only in the resumed generator, never mutate the workspace
  after an asynchronous read. Late failures remain observed.

The startup structure tests count shared-dependency stat calls and verify lazy type
projection, inherited macro-context changes and dependency edits after cancellation. The I/O cancellation test leaves an operation unresolved and checks that
cancellation closes the generator, including when that operation later rejects.
Existing macro-context, cyclic-include, background cancellation and native syntax
compatibility tests cover the surrounding behavior.

Request transactions record the original value of each changed map key and each
changed reverse-edge/candidate-set membership once. Unchanged entries are not
copied. Recording is active only while the generator executes, so notifications
between yields do not become transaction writes. Rollback restores entries and
invalidates derived caches for affected graph/context/document URIs. If a newer
external revision has arrived, it clears analysis caches instead of restoring stale
state. Successful foreground and background work explicitly releases the journal.

## Remaining work

Type snapshots yield during cursor traversal, but native parsing and several other
semantic passes remain synchronous. Semantic analysis still rebuilds the affected
document; required pre-/post-expansion symbol passes remain.

Priorities for further measurement:

| Area | Evidence / next experiment |
| --- | --- |
| Cold analysis and edits | Native incremental reuse is limited by fragile grammar subtrees. The current binding has no Tree.copy(); parsing unchanged source to protect old readers can cost nearly a full parse. Measure grammar reuse and safe ownership before enabling incremental parsing. |
| Type lookup tradeoff | Name indexes reduce large-scope scans but add maps and allocation. Compare tiny vs large scopes and many classes/overloads; do not assume every type-checking workload improves. |
| Workspace-scale cancellation | Mutation journals avoid full document/dependency map snapshots. Measure high fan-in graphs and cancellation with simultaneous document revisions; stale-revision recovery still clears caches conservatively. |
| File discovery and dependency I/O | Workspace symbols still reconcile filesystem fingerprints to recover missed events. Measure large trees, network disks and include fan-out; cache changes must retain missed-event correctness. |
| Documentation / GUI / startup | Include comment-heavy and real SDK/login projects. Portable fixtures cannot establish their production bottlenecks. |
| Memory and fairness | Extend repeated open/close, edits and cancellations across many files; capture heap retainers, native RSS and event-loop delay. Syntax parsing and individual generator steps remain synchronous. |

Keep these areas as hypotheses until measured. Parser changes belong in
tree-sitter-axel when syntax/parser behaviour is the cause; dependency publication
to the extension is a separate release step. The extension currently pins its
published server dependency, so local server changes alone do not replace that
installed dependency.
