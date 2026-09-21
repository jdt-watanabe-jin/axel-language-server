# Declaration, type definition, implementation and selection

The development server provides `textDocument/declaration`, `textDocument/typeDefinition`, `textDocument/implementation` and `textDocument/selectionRange`. Use the client's standard navigation and expand/shrink selection commands; no feature-specific setting is needed.

- **Declaration** prefers visible matching function/method prototypes, falling back to the definition when no separate declaration exists. Ownership, lexical scope and AXEL signature rules distinguish targets. Existing Definition navigation continues to prefer the body.
- **Type definition** follows the static type of variables, parameters, fields, type names and GUI parts. Pointer/reference/array layers are unwrapped. A typedef use goes to its nearest alias; invoking the operation on that alias declaration follows the next alias or underlying class. Builtin types without aliases, unresolved or ambiguous types, and function pointers return no target.
- **Implementation** returns matching function/method bodies and virtual overrides. For a class target, it returns transitive concrete derived definitions; pure virtual obligations inherited without an override exclude an abstract class. It is static navigation, not a prediction of runtime dispatch.
- **Selection range** walks the original syntax tree from the requested position outward, eliminating duplicate ranges. Multiple positions, comments, strings, CRLF, UTF-16 positions and incomplete syntax are supported. Only enclosing ranges present in the tree are returned. It uses the source syntax queue independently of semantic dependency analysis.

Declaration and type resolution use visible includes and shared startup declarations. Implementation enumeration uses the common [project scope](workspace-symbols.md): unopened files participate, excluded or external dependency files can supply type information without becoming implementation results. Different conditional-compilation variants are not merged. Unsaved buffers override disk contents; changes, closing, deletion and configuration updates invalidate dependent records. Canceled or stale work is not published as current navigation.

The `workspaceSymbols` outline mode does not restrict these navigation operations. Selection always uses original source syntax. These APIs are available in the linked development build; this does not update the extension's pinned Git dependency or publish a release.

The shared project index is built on demand for Implementation and subtype searches, including implementation-count Code Lens resolution. The first such search may wait for indexing; the server does not prebuild this index at startup. Subsequent searches reuse it, with background updates after edits.

Protocol and semantic regression tests are in `src/test/e2e/r1Navigation.test.ts` and `src/test/integration/features/r1Navigation.test.ts`. Selection scheduling is covered by `src/test/unit/r1SelectionScheduling.test.ts`.
