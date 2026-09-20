# Type Hierarchy

Type Hierarchy explores direct, explicitly declared base and derived types of AXEL classes, structs and unions, including GUI classes. Start from a type name, typedef, variable, parameter, field or GUI part declaration or reference. Variables use their static declared type; pointer, reference and array layers are unwrapped. Typedefs lead to the underlying class rather than a separate hierarchy item.

For example, preparing `value` in `class Derived : Base {}; Derived *value[2];` selects `Derived`. Its supertypes contain `Base`; expanding subtypes of `Base` finds `Derived`, including declarations in unopened project files.

Subtype discovery uses the shared `project.include` and `project.exclude` configuration described in [configuration](configuration.md). Excluded files are not subtype candidates. Open documents and resolved includes, forced includes and startup dependencies remain available for type resolution and navigation to base types, even outside that scope. Changes to settings and files take effect without a restart; unsaved open contents take precedence over disk contents.

Basic types, enums, function names, function pointers, arbitrary expressions, unresolved or ambiguous types, inactive code and syntax-recovery regions do not start a hierarchy. GUI containment and field membership are not inheritance. Only definite, unambiguous source declarations and direct inheritance edges are shown. This feature does not add Go to Type Definition.

The server advertises `typeHierarchyProvider` and implements `textDocument/prepareTypeHierarchy`, `typeHierarchy/supertypes` and `typeHierarchy/subtypes`. No additional client command or feature-specific exclusion setting is required. If an item becomes stale after editing or the server restarts, prepare the hierarchy again.
