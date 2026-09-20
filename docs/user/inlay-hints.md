# Parameter-name inlay hints

The server advertises `inlayHintProvider` and serves standard `textDocument/inlayHint` requests. Hints are disabled by default. Send the following top-level object in the `axel` item of the `workspace/configuration` response:

```json
{
  "inlayHints": {
    "parameterNames": {
      "enabled": true,
      "suppressWhenArgumentContainsName": true
    }
  }
}
```

Both fields accept booleans. Missing values independently select `enabled: false` and `suppressWhenArgumentContainsName: true`. Invalid values reject the complete configuration snapshot. Configuration notifications trigger a new request; its response supplies the complete current settings. Changes take effect without editing documents or restarting the server. Editor visibility settings still apply.

For `void consume(int count)`, a call `consume(10)` receives `count:` before `10`. Each hint uses `InlayHintKind.Parameter` and right padding. Functions and methods in user source, visible includes and built-in declarations are supported. Only named fixed parameters receive hints; omitted parameters, unnamed parameters and variadic arguments do not.

Call selection shares navigation and type analysis. Ordinary AXEL functions retain their existing arity-based identity. Built-in overloads use argument types and arity. When multiple candidates remain, a position receives a hint only if every candidate has a non-variadic parameter whose name matches exactly, including case. No matching complete arity produces no hints. Editing-time calls use partial argument resolution when the parser retains a usable call and argument structure; ambiguous or damaged argument correspondence is omitted.

By default, a name already present anywhere in the original argument text suppresses its hint. Comparison uses locale-independent lowercase and substring matching, so `count`, `itemCount`, `discount`, `COUNT` and `"count"` all suppress `count:`. Leading and trailing comments belong to the argument segment bounded by that call's direct delimiters. Nested-call commas, commas in strings and commas in comments do not split segments. Disabling suppression displays all otherwise eligible hints. String escapes and macro replacement values are not substituted for comparison.

Inactive or uncertain code is excluded. Macro expansion uses source provenance: scalar arguments and exactly mapped written arguments can receive hints; several expanded arguments mapped to one source argument are omitted. Repeated expansions do not duplicate an identical hint. Generated call targets without an exact source spelling are omitted.

Only hint positions within the requested range are returned, including arguments whose callee starts before that range. Cancellation and document/configuration/dependency changes follow the shared request lifecycle and return standard cancellation or content-modified errors instead of stale successful responses.

The server requests `workspace/inlayHint/refresh` only when the client advertises `workspace.inlayHint.refreshSupport`. Configuration changes, watched-file changes, open-document lifecycle updates and background indexing completion refresh dependent hints.

Implementation belongs to `src/analyzer/inlayHints.ts`; `src/lsp/inlayHints.ts` normalizes settings and converts results, and `src/lsp/registerHandlers.ts` integrates the request lifecycle. The existing immutable type snapshot retains direct argument delimiters separately from expression children. Navigation and call resolution cache exact starting positions within the current analysis generation. No per-argument parsing or separate semantic index is used.

Run `npm run test:fast`, `npm run test:e2e`, `npm run test:performance -- --grep "inlay hints performance"` and `npm run lint`. Analyzer and real stdio tests cover suppression, source positions, overloads, macro mapping, dependencies, settings, cancellation and stale versions; the performance regression covers 5,000 calls and a subsequent edit.
