# Document symbols

The outline groups out-of-class method definitions such as `Version::makeVersion` under a uniquely matching class, struct, or union in the same document. Ordinary methods use Method, constructors use Constructor, and operators use Operator. If the owner is absent or ambiguous, the symbol stays at document level with its qualified name.

Overloads remain separate entries; external definitions show their signatures in the detail. In-class declarations and external definitions remain separate navigation targets. Inactive preprocessor branches are excluded before owner lookup.

## Navigation limitation

Each symbol retains its physical source range. Clicking an external method in the outline navigates to its definition. VS Code currently searches a parent's range before its children for breadcrumbs and outline cursor tracking, so these features cannot identify an external method nested outside its class's range. Expanding the class range would incorrectly include unrelated declarations between the class and its methods.

GUI event handlers continue to use their existing receiver-path hierarchy.
