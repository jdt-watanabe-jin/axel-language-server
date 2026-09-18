# Call hierarchy implementation

The server implements the standard LSP call hierarchy requests:

- `textDocument/prepareCallHierarchy`
- `callHierarchy/incomingCalls`
- `callHierarchy/outgoingCalls`

`initialize` advertises `callHierarchyProvider: true`. The LSP layer converts between protocol items and analyzer items; the analyzer owns symbol identity, semantic resolution, graph construction, and source ranges. Cancellation and document-generation validation use the same queued request lifecycle as the other semantic LSP features.

## Data flow

`src/lsp/callHierarchy.ts` validates the item returned by the client, including its opaque `data.key` and `data.sourceUri`. Prepare requests analyze the current open document. Incoming and outgoing requests restore the original requesting context from `data.sourceUri`: an open document is reanalyzed from its current unsaved text, while a closed context must still have a current analyzed document in the workspace index. Missing context, malformed data, or an item that no longer resolves produces an empty relation list. Cancellation remains an LSP cancellation error rather than an empty successful response.

The analyzer is split by responsibility:

- `callHierarchySemantics.ts` reuses type checking to collect resolved calls, function value references, and override pairs. It records direct and member calls, constructors, overloaded operators, user conversions, and explicit destructor calls at their source expressions.
- `callHierarchySymbols.ts` creates callable items and ownership items for global or member initializers, GUI events, and file-level executable source. It maps macro-expanded ownership back to written source ranges.
- `callHierarchy.ts` builds a context graph, canonicalizes compatible declarations and definitions, adds resolved call and function-reference edges, follows base-method relations for incoming requests, groups repeated locations, and returns stable ordering.
- `WorkspaceIndex.callHierarchyTypeInput` supplies the ordinary include context, forced includes, startup shared scope, built-in catalog, and position-aware macros used by semantic resolution.

Each public item carries a stable structural key plus the URI of the document whose analysis context created it. The key includes the declaration URI, owner, normalized callable shape, and local owner where needed; it does not store a syntax node or absolute text offset. Expansion resolves that key against the current graph. A deleted or changed symbol therefore becomes empty instead of rebinding to another function with the same name.

Declaration and definition unification respects actual visibility. A definition is preferred when a compatible declaration and definition belong to the same visible context. A shared header prototype can resolve independently to different definitions in separate AXEL scripts; the graph maintains per-document aliases so those implementations are not merged through a workspace-wide name match. File-local and local-scope identities remain separate.

## Edges and ownership

Calls and function value references use the type checker's resolved target set. Navigation supplies remaining resolvable references only when the visible context does not leave multiple callable identities with the same name and owner. This supports callback registration, assignment, argument passing, and returns without selecting an arbitrary overload. Resolution follows existing AXEL rules: numeric overload candidates are not ranked by C++ conversion preference, and initialization or assignment does not acquire user conversion operators that AXEL type checking rejects.

Macro references retain expanded coordinates for ownership. The optional `expandedSource.referenceRange` maps parameter-origin text to the written argument while generated body tokens map to the macro invocation. The existing `sourceRange` contract for declarations remains unchanged. GUI event owners also retain expanded ranges, so expansion inside an event does not move its calls to file scope.

An edge belongs to the innermost callable or initializer owner containing its source position:

- references in a function or method body belong to that callable;
- local variable initialization belongs to the enclosing callable;
- global and member initialization belongs to the variable or field;
- GUI event bodies belong to their resolved event item;
- otherwise valid file-level executable source belongs to a synthetic file item.

Default arguments in prototypes do not become file-level execution. Local-class field initialization remains owned by the field rather than the enclosing function. Repeated edges to the same item are grouped and their source ranges are deduplicated and sorted.

For virtual methods, outgoing calls retain the statically resolved target. Incoming expansion of a derived override also traverses its resolved base-method chain and includes references to those base methods. This relationship is intentionally asymmetric. Recursion and mutual recursion remain in the graph; each LSP response returns one adjacent level and does not recursively expand the hierarchy on the server.

## Cache and invalidation

Call hierarchy caches are held in a `WeakMap` keyed by the workspace index, so an index and all of its cached graph state can be collected together. Per-document semantic data is held in a `WeakMap` keyed by immutable `AnalyzedDocument` objects and is reused only while the dependency document identities and built-in catalog are unchanged.

Graphs are keyed by the requesting source URI, request direction, and selected position or symbol. A cached graph is reused only when the ordered set of analyzed document objects is unchanged. At most eight query graphs are retained; inserting a ninth evicts the oldest entry. Edits produce new analyzed document objects, and include, watched-file, open/close, startup-scope, forced-include, Tool, and other configuration invalidation flows update or clear the workspace documents. The identity check then rejects the old graph on the next request. Old graph objects may remain reachable in the bounded cache, but they cannot satisfy a request whose document generation changed.

Symbol identity and ownership are collected before call edges. Preparing a declaration does not analyze unrelated function bodies. Outgoing requests collect edges from the resolved owner's document. Incoming requests for ordinary functions and methods inspect documents containing that name in their declarations or references, including expanded macro references; constructors, operators, conversions, and destructors retain a full search because their uses may be implicit. Semantic results are reused across these query graphs. Navigation fallback first excludes names that cannot identify any callable, avoiding a full source-position search for every ordinary variable or field reference.

The graph uses `listReferenceSearchDocuments`, which contains documents already known to the workspace index plus the configured startup scope. Visibility sets still govern identity and resolution, so the presence of another indexed file does not make an unrelated declaration visible. The feature does not crawl arbitrary workspace directories. Background indexing may make more indexed relationships available to a later request; an earlier empty result is not a guarantee that the symbol has no workspace callers.

## Supported boundaries and limits

The graph includes resolved ordinary, static, and instance functions and methods; constructors; operators; conversions; explicit destructors; and unambiguous function value references. Macro-generated calls are mapped back to written source, including argument-origin positions. Inactive branches, uncertain branches, syntax-recovery ranges, comments, strings, type-only references, and unresolved expressions do not create edges. Independently valid code outside a broken range can still contribute relationships.

The implementation deliberately does not:

- infer a later indirect call target from an assignment to a function pointer;
- synthesize runtime callback dispatch or GUI event delivery paths;
- create implicit destructor calls for scope exit or unwinding;
- expand a static virtual call to every possible derived implementation;
- invent an unresolved target or confidence field;
- search files that the workspace index has not analyzed.

Variables, fields, and synthetic file items are execution owners for initializer or file-level relationships. They are not a general data-flow or read/write hierarchy. Protocol positions use the analyzer's source ranges and therefore follow LSP UTF-16 coordinates for LF and CRLF text.

## Verification

Analyzer regression coverage is in `src/test/integration/features/callHierarchy.test.ts`, `callHierarchySemantics.test.ts`, and `callHierarchyInvalidation.test.ts`. Performance and cancellation coverage is in `src/test/performance/callHierarchy.test.ts`. The stdio protocol test is `src/test/e2e/callHierarchy.test.ts`; it verifies capability advertisement, all three requests, grouped ranges, unsaved edits, stale and malformed items, and cancellation propagation.
