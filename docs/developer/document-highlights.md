# Document highlights

`documentHighlightProvider` advertises the standard `textDocument/documentHighlight` request. The server returns explicit Text, Read, or Write kinds and name-only ranges in the current document. Identity comes from semantic resolution rather than a same-name text search. Include and shared-scope declarations participate in resolution without adding ranges from other documents.

`src/analyzer/documentHighlights.ts` owns symbol identity and document-local collection; `documentHighlightAccess.ts` classifies accesses, and `documentHighlightMacros.ts` binds source macro names using the preprocessor evaluator's activity and definition certainty. Macro expansion retains exact argument origins and the source names actually expanded, including macros producing empty output. Generated names and unused, stringified, or pasted-only argument names cannot enter the result through a textual fallback. Cooperative generators return analyzer ranges and string kinds. `src/lsp/documentHighlights.ts` converts those kinds to protocol values and uses the normal request queue, current open-document analysis, cancellation checkpoints, and workspace-revision validation in `registerHandlers.ts`. Unsaved text is used. Cancellation and content modification remain protocol errors; other analysis errors are logged and return an empty list without reusing stale highlights. No dedicated settings or commands are registered.

Initialized declarations and written targets are Write; ordinary value uses are Read; uninitialized declarations, parameter declarations, functions, types, and user macro names are Text. Compound assignments and increments are Write. Receivers, indexes, and pointer variables used to locate another write target remain Read. `sizeof` operands are conservatively Text. Calls do not infer writes from runtime side effects.

Ambiguous or unresolved occurrences, comments, strings, inactive or uncertain code, system macros, and macro parameters are excluded. User macro names are separate from their expansions. Argument occurrences require a surviving semantic reference mapped to the original identifier; unused, stringified, or pasted-only arguments do not become ordinary references. Compatible function declarations and definitions share an identity, while their parameters remain separate. Static method resolution does not combine overrides.

## Verification

Run from the Language Server repository:

```sh
npm run test:e2e -- --grep 'LSP stdio Document highlights'
npm run test:integration -- --grep 'Document highlight'
npm run test:performance -- --grep 'Document highlights'
```

The stdio tests verify capability advertisement, exact ranges and all three kinds, missing documents, cancellation, and unsaved edits. Handler lifecycle tests verify failure logging without stale results and ContentModified while analysis is pending. Analyzer tests verify symbol and source semantics separately.

The extension's `src/test/host/documentHighlights.test.ts` exercises `vscode.executeDocumentHighlights` against the actual server through the Language Client. Editor highlight timing and theme colors require separate manual verification. A successful local linked-server test does not update the extension's pinned distribution dependency `axel-language-server#v0.1.0`.

Qualified assignment targets such as `A::value = 1` require the corresponding parser correction. Link and rebuild both repositories; the pinned `tree-sitter-axel#v0.1.0` dependency is also unchanged.

The performance suite fixes 1,000 and 5,000 references, zero dependencies and macros, and ten repeated requests. It reports initial analysis, repeated median/p95, edited analysis, and asynchronous cancellation separately. The test environment budget is 1,000 ms for repeated p95 and cancellation. It is a regression threshold, not an end-user latency guarantee.

## Reuse and invalidation

Completed occurrence groups are cached per analyzed source and workspace. Cursor movement selects from these groups without repeating semantic resolution for every reference. Cache hits require identical source/dependency documents, builtin catalog and startup scope. Results are installed only after collection completes; cancellation during collection cannot retain a partial index. Source edits replace weak cache keys, and dependency/configuration changes invalidate the owning workspace inputs.

The workspace also reuses position-aware call inputs for inlay hints and type navigation. Semantic token results validate the source and ordered visible declaration identities before reuse; they do not force background dependency indexing. Scope lookup uses an immutable interval index with the original end-exclusive containment, smallest-range selection and stable tie order. Regression coverage is in `performance/interactiveReuse.test.ts`, `performance/scopeLookup.test.ts` and `unit/navigationReuse.test.ts` under `src/test/`.

Cold startup still includes parsing external headers and the selected startup script. Measure cold requests separately from repeated requests, and use the same source encoding, settings, request order and dependency state when comparing timings. Syntax-only folding skips single-line subtrees while retaining region markers; `performance/foldingTraversal.test.ts` verifies the traversal budget and the existing folding tests verify ranges.
