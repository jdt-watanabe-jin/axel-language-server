# Type checking

The language server checks AXEL types while analyzing documents and publishes errors through the existing LSP diagnostics channel. This implementation is available in the source checkout; an older published server tag does not gain it automatically. Clients must load a build containing the implementation and its compatible Tree-sitter parser.

## Runtime profile and scope

The compatibility baseline is standalone AXEL 510, SX-Meister 20.0.0 (`__SXM_VERSION__ = 2000000`), on Windows. Compiler error output is authoritative, including errors reported when `LoadFunction` succeeds or the process exits successfully. C++ conventions and declarations written for editor assistance do not override observed AXEL behavior.

Checks cover initialization, assignment, function calls and returns, operators, conditions, casts, pointers, arrays, constant-expression requirements, and selected invalid declarations. For example, `int *p = NULL;` is accepted, but `int *p = 0;` is rejected. AXEL permits reassignment of a `const int`; applying the C++ rule would produce a false error. A source `#define NULL 0` makes subsequent uses ordinary integer zero, and `#undef NULL` restores the builtin token.

User-defined functions and methods can share a name when their parameter counts differ, including methods defined outside a class. Definitions with the same name and parameter count in the same owner scope are rejected even if their parameter types differ. GUI event handlers on different instance paths are distinct definitions.

A fully defined user class with no instance data, including inherited data, cannot be instantiated as a variable or array (C56). Merely declaring the class, a pointer, or a value parameter does not trigger this check. Registered analysis declarations may represent hidden runtime data and are exempt.

The server uses definite declarations visible through the document, resolved includes, and configured forced includes. Inactive branches do not contribute types. Unresolved names, incomplete syntax, and uncertain preprocessor branches suppress diagnostics that require unavailable type information. Absence of a diagnostic is not proof that an arbitrary AXEL program will compile. The implemented rules are bounded by regression cases; other runtime versions and general combinations of language features require further verification.

Class subscripts use declared `operator[]` signatures, including inherited declarations. Registered `VARRAY` uses an integer index and returns a pointer to an unspecified element type, consistent with `GetAt`. An explicit cast such as `*(int*)values[i]` supplies the element type; the subscript result itself is not assignable. Each VARRAY manages one element type at runtime. Mixing element types in `Add` is a runtime error, not a compile-time diagnostic, so the checker does not infer a permanent element type from an earlier `Add` call.

## Registering analysis declarations

Use the existing `forcedIncludeFiles` configuration to select an analysis header. Place a companion JSON file beside the entry, replacing its last extension with `.analysis.json`: `builtins.h` uses `builtins.analysis.json`. There is no separate type-checking configuration switch. For a generic LSP client, initialization options can contain:

```json
{
  "forcedIncludeFiles": ["D:/axel-analysis/builtins.h"]
}
```

A minimal companion is:

```json
{
  "schemaVersion": 1,
  "profile": "axel-510",
  "declarationFiles": ["builtins.h", "types/natural.h", "types/string.h"],
  "types": {
    "natural": "types/natural.h",
    "string": "types/string.h"
  },
  "analysisOnlyMacros": []
}
```

Each listed file must exist inside the companion directory. List every analysis declaration source explicitly, including the entry if it contains declarations and any transitive headers that require analysis-only treatment. Adding an include to a header does not extend this allowlist. A role string binds a declaration of the same name in that file; an explicit binding such as `"unit": {"file": "types/unit.h", "name": "Unit"}` supports a different declaration name.

Registered declaration files supply signatures and builtin identities without being checked as executable AXEL source. This permits editor-only function prototypes. An ordinary forced include without a valid companion receives no exemption. A user-defined `class natural` does not inherit the registered builtin's conversion rules merely because its name matches. Invalid schemas, unknown profiles, missing files, and paths outside the companion directory grant no special handling for that manifest.

`includeRoots` provides include search paths; it does not register builtin types. For reliable registration, specify the entry in `forcedIncludeFiles`. Files with the name `_axel_intellisense_def.h` have no implicit privilege.

## Changes and troubleshooting

Changes to source, configuration, or a notified included file trigger renewed analysis. The server invalidates its builtin catalog when notified of changes to a companion or registered declaration file; dependent diagnostics are recomputed even when the source document version is unchanged. A client must deliver file-change notifications for external headers and JSON companions. The corresponding VS Code extension source includes a watcher for companion files. If it does not watch these files, restart its language server after editing them.

If builtin conversions or prototype handling look wrong, verify the loaded server/parser build, the explicit entry path, the companion's profile, and its file list. Keep analysis-only headers out of runtime compilation. Their declaration syntax and contents serve editor analysis, while the runtime profile defines executable behavior.

See [developer architecture and verification](../developer/type-checking.md) for regression coverage and the optional runtime runner.
