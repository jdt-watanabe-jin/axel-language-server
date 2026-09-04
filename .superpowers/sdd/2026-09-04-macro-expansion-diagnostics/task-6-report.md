# Task 6 Report: Hover Expansion For Function-Like Macros

Status: DONE

## Summary

Implemented hover expansion output for known function-like macro invocations in `axel-language-server`.

Changes made:

- Added hover tests for direct and included function-like macro invocations.
- Extended the hover workspace interface with optional visible macro lookup.
- Added a macro invocation hover path before normal reference hover fallback.
- Used `AnalyzedDocument.macroInvocations`, `WorkspaceIndex.findBestVisibleMacroDefinition`, and `expandMacroInvocationText`.
- Preserved object-like macro behavior by returning expansion hover only for function-like macro definitions.
- Kept expansion display scoped to hover; no semantic diagnostics over expanded code were added.

## TDD Evidence

RED:

- `npm run build` passed after running with permissions that allow writing `out/*`.
- `npm test -- --grep "shows expansion for function-like macro invocation hover|shows nested expansion"` failed with both new tests failing because hover returned only the macro definition, not `Expansion:`.

GREEN:

- `npm run build` passed.
- `npm test -- --grep "macro references|function-like macro|shows expansion"` passed with 13 passing tests.

## Full Verification

- `npm test` passed with 335 passing tests.
- `npm run lint` passed.

## Notes

The nested included macro case initially expanded to a single-line adjacent statement sequence:

```text
int value; int *Find(string key) { return NULL; }
```

Hover presentation now formats adjacent semicolon-separated expansion statements onto separate lines while avoiding splits before closing braces, matching the Task 6 expected hover output without changing the shared macro expansion engine semantics.

## Commit

- Created with a Japanese Conventional Commit message. See git history for the final hash.
