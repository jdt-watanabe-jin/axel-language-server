# Type-checking architecture and verification

Object-like command prefixes are handled by [macro command recovery](../../src/analyzer/macroCommands.ts). When an erroneous declaration-shaped statement, or a macro identifier followed by an `@script` command node, expands to one valid Tree-sitter command statement, the analyzer replaces its false declarations with references from the unchanged argument suffix and substitutes the recovered type snapshot. Source locations remain attached to the original arguments. An `@script` argument is part of the recovered command, not a separate script execution. Macro visibility, inactive regions, `#undef`, and bounded expansion apply; malformed expansions retain diagnostics. This is targeted recovery, not full preprocessing of the document.

`F(&item);` and `T(*item);` can have declaration-shaped trees because AXEL permits parenthesized pointer declarations. [Call disambiguation](../../src/analyzer/ambiguousCalls.ts) resolves a visible function or method in the current document's lexical scopes, including definitions later in the file, before reparsing the statement in an expression context. Tree-sitter supplies the call and argument nodes; source ranges are preserved, false declarations are removed, and normal argument diagnostics apply. Type names retain their declaration interpretation.

Preprocessor directive operands are marked separately in reference data. Ordinary semantic diagnostics exclude those references, and expression type checking skips conditional directive operands. Undefined identifiers in `#if`, `#elif`, `#ifdef`, and `#ifndef` do not produce unknown-identifier errors; active branch bodies retain ordinary diagnostics. Macro references remain available to navigation and highlighting.

## Ownership and data flow

Tree-sitter remains the authoritative syntax parser. [DocumentAnalyzer](../../src/analyzer/documentAnalyzer.ts) copies each parse into a document-generation-local [type snapshot](../../src/analyzer/typeChecking/syntax.ts); native nodes are not retained across edits. [WorkspaceIndex](../../src/analyzer/workspaceIndex.ts) supplies definite visible documents, position-aware macros, and the builtin catalog before aggregating type diagnostics with existing diagnostics and applying the configured problem limit.

[Declaration resolution](../../src/analyzer/typeChecking/declarations.ts) first creates lexical scopes and class identities, then resolves bindings, signatures, aliases, and declarator shapes. Forward declarations and their definitions share an identity in the same scope. Inactive and uncertain declaration subtrees are excluded. Class roles come from a normalized declaration URI and exact declared name in the [catalog](../../src/analyzer/typeChecking/builtinCatalog.ts), and resolve onto the selected class identity. Never apply builtin rules by comparing an unresolved type-name string.

[Compatibility](../../src/analyzer/typeChecking/compatibility.ts) is a direct relation parameterized by use site. Numeric conversions, user conversion methods, initialization, assignment, arguments, and returns have different rules. Do not search a conversion graph: a class conversion to `int` plus a numeric conversion from `int` to `double` does not imply a class-to-`double` conversion. [Expression analysis](../../src/analyzer/typeChecking/expressions.ts) uses storage/temporary/reference categories and callable candidates; [diagnostics](../../src/analyzer/typeChecking/diagnostics.ts) checks statements and declaration restrictions.

`ExpressionResult.constant` contains an evaluated value only when known. `constantExpression` records that an expression qualifies as constant without inventing a value. In particular, `sizeof` can satisfy an integer constant-expression requirement without the server assuming a runtime size. Preserve this distinction when composing expressions; an arbitrary placeholder integer would corrupt duplicate-case checks and constant evaluation.

Builtin behavior follows the observed AXEL 510 / SX-Meister 20.0.0 Windows profile. Registered editor declarations may contain prototypes or omit runtime restrictions. Their signatures support lookup, but they are exempt from executable-source type diagnostics. Header syntax belongs in the parser; runtime conversion and operator rules belong in this server. Correct erroneous analysis headers instead of emulating C++ behavior downstream.

## Catalog and invalidation contract

The companion format and client setup are described in the [user guide](../user/type-checking.md). `loadBuiltinCatalog` validates each companion atomically: schema version 1, profile `axel-510`, explicit existing relative declaration files, and role bindings to those files. Absolute paths, escaped paths, external symlink targets, conflicting bindings, and unknown profiles fail closed. A failed companion contributes an issue to the returned catalog instead of granting partial exemptions. Valid independent companions remain usable.

The `analysisOnlyMacros` field accepts `[]` or a list containing `NULL`. Opting into `NULL` identifies helper definitions from the entry and its exact declaration allowlist; expression type analysis ignores those legacy helper definitions. It does not ignore a user-source redefinition or exempt an unrelated forced include. Shipped analysis headers should use AXEL's builtin `NULL` token instead of defining it as integer zero. Source definitions and `#undef` must retain position and origin, and conditional evaluation and expression analysis must agree on the visible definition.

Document versions alone do not identify an analysis context. Changes in visible includes, macros, forced entries, configuration, and notified companion/declaration files invalidate dependent results. Catalog registration must never exempt all forced includes or all headers with a familiar basename. Regressions must exercise unchanged source versions with changed dependencies as well as normal edits.

## Regression coverage

The checked-in [corpus manifest](../../src/test/integration/fixtures/type-checking/manifest.json) fixes source hashes, expected compiler errors, error codes, and evidence identifiers for 156 ordinary cases and one separately tracked compiler crash. A crash has `expectedError: null`; it is not an accepted program or an ordinary type error. The corpus covers the initial observations and their follow-up experiments, rather than asserting complete equivalence with AXEL.

The [conformance suite](../../src/test/integration/features/typeCheckingConformance.test.ts) runs 135 selected ordinary cases through the actual analyzer and workspace diagnostics. The 21 redundant ordinary cases remain as evidence; the selection and reasons are explicit in [the corpus helper](../../src/test/support/typeCheckingCorpus.ts). Small handwritten registered headers make ordinary CI independent of product header copies and an installed AXEL runtime. [Declaration tests](../../src/test/integration/features/typeDeclarationResolution.test.ts), [operator and overload tests](../../src/test/integration/features/typeCheckingOverloads.test.ts), and [context invalidation tests](../../src/test/integration/features/typeCheckingContext.test.ts) cover supporting behavior beyond the corpus. Parser grammar contracts belong in tree-sitter-axel; server regressions assert diagnostics and feature results from actual source.

```sh
npm run test:unit -- --grep "Type checking"
npm run test:integration -- --grep "Type checking"
```

Ordinary checks do not start AXEL. Successful corpus checks establish agreement with those recorded expectations only; unsupported generalizations and different runtime versions need new evidence and regression cases.
