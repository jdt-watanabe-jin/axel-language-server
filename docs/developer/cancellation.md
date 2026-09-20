# Request cancellation and cooperative analysis

All registered language-feature requests accept the LSP cancellation token, including disabled features and requests for missing documents. `initialize` and `shutdown` check cancellation before changing session state. Notifications are not cancellable requests.

A cancelled request returns `RequestCancelled` (`-32800`). It is not converted into an empty successful result and is not logged as an analysis failure. A document, configuration, watched-file, or lifecycle change during a language-feature request returns `ContentModified` (`-32801`) instead of publishing a stale result. Completed valid analysis can still be reused; cancellation does not undo notifications already sent before it was observed.

## Execution model

`createRequestHandler` serializes language-feature requests that use the same mutable workspace. A cancelled queued request responds without waiting for its predecessor and never starts analysis. Cancellation listeners are disposed when the request settles. A running request stops at the next cooperative boundary; another request starts after its cleanup completes.

`WorkspaceIndex.analyzeRequestDocument` uses the existing include/context pipeline through `runAnalysisStepsAsync`. Requests wait for the required dependency context and completed diagnostics, instead of using the synchronous diagnostic API's provisional result. Dependency traversal remains ordered because includes and macros can depend on preceding context. Disk dependencies first retain include, macro and undef events, then build complete symbols with the resolved context. Nested macro events at the same visibility position retain their final state. Completed forced-include analyses are shared with the isolated startup index through separate mutable index containers; startup macro state is not shared back into ordinary documents. Reference search filters by symbol name before resolving candidates.

The pipeline yields to the event loop between document analysis passes and dependency files. File status and source reads use `fs.promises.stat` and `fs.promises.readFile` on the asynchronous path. Type-diagnostic traversal, reference search, rename edit construction, and formatting loops also yield in batches. `setImmediate` boundaries allow the transport to receive `$/cancelRequest`; a resolved promise alone would not do this.

The synchronous APIs remain available for tools and existing callers. Both paths execute the same generators, with synchronous or asynchronous adapters for file operations. Document lifecycle foreground indexing uses the same cooperative queue; background file I/O still has a synchronous adapter. Tree-sitter's native `parse` call, individual tree passes, macro text expansion, and some feature-specific lookups remain synchronous. Cancellation latency is therefore bounded by the next checkpoint, not by a hard real-time deadline. This is cooperative scheduling in one process, not parallel CPU parsing; an in-progress filesystem operation is allowed to finish before its result is discarded.

## Shared state

- Request analysis suspends background advancement while it owns the workspace.
- External edits, close events, settings, and watched-file changes invalidate the request revision. Open-document inputs are updated as soon as a change notification arrives, even when foreground indexing is coalesced.
- Revision and token checks run before resuming suspended work and before returning results. Include-resolution caches are scoped to each synchronous generator step, never held globally across an `await`.
- An interrupted workspace traversal rolls back provisional analysis and dependency writes while retaining valid pre-request documents and open inputs. If the revision changed externally, no old snapshots are restored: open documents are queued for rebuilding, and requests restore missing foreground indexes before searching references. Suspended generators are closed so cleanup runs. Background work resumes, and subsequent requests rebuild missing state.
- Document-notification indexing belongs to the workspace rather than the request that flushes it; cancelling that request does not discard pending updates for other documents. Interrupted notification work retries the latest still-open document.
- LSP handlers check the session revision before publishing inactive ranges and returning responses. Formatting and reference/rename construction also check it between batches.

When adding a request, register it through the shared request wrapper. Preserve cancellation and content-modified errors through catch blocks. When adding a long traversal or I/O operation, expose a generator step and keep the synchronous adapter rather than duplicating language-analysis logic.

## Verification

Run `npm run test:ci` for lint, unit, integration, stdio, and performance tests. Relevant regressions cover every registered request, cancellation while queued, cancellation during include traversal and result construction, retry after cancellation, edits/configuration/close/invalidation during suspended analysis, and actual stdio cancellation followed by another successful request. Extension Host integration should use the locally linked server; release integration requires updating the extension's published server dependency separately.

For installation-specific latency, set `AXEL_PERF_SAMPLE`, `AXEL_PERF_SETTINGS` (JSON object returned as the axel configuration item), `AXEL_PERF_RENAME_SYMBOL` and optionally `AXEL_PERF_RENAME_COUNT`, then run `npm run test:external -- --grep 'external rename performance'`. Use a local symbol unique to that sample. The test reports cold outline and warm rename times over stdio without applying edits; the warm local rename budget is 500ms. Include roots are lookup paths, not scan targets. Forced include discovery recursively enumerates explicit `forcedIncludeRoots`; project candidate collection separately enumerates workspace roots through `ProjectScope`, applying `project.include` and `project.exclude`.
