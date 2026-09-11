import * as assert from 'assert';
import { CodeActionKind, CompletionItemKind, DiagnosticSeverity, SemanticTokenModifiers, SemanticTokenTypes, TextDocumentSyncKind } from 'vscode-languageserver/node';
import { createInitializeResult } from '../../lsp/capabilities';

import { toLspCompletionItem } from '../../lsp/completion';
import { toLspDiagnostic } from '../../lsp/diagnostics';

import { SEMANTIC_TOKEN_LEGEND, toLspSemanticTokens } from '../../lsp/semanticTokens';

import type { AnalysisCompletionItem, AnalysisDiagnostic, AnalysisSemanticToken } from '../../types/analysis';

suite('LSP adapters', () => {
  test('advertises the hover capability', () => {
    const result = createInitializeResult();

    assert.strictEqual(result.capabilities.textDocumentSync, TextDocumentSyncKind.Incremental);
    assert.strictEqual(result.capabilities.documentSymbolProvider, true);
    const triggerCharacters = result.capabilities.completionProvider?.triggerCharacters ?? [];
    assert.ok(triggerCharacters.includes('p'));
    assert.ok(triggerCharacters.includes('r'));
    assert.ok(triggerCharacters.includes('_'));
    assert.ok(triggerCharacters.includes('/'));
    assert.ok(triggerCharacters.includes('@'));
    assert.ok(triggerCharacters.includes('\\'));
    assert.ok(triggerCharacters.includes('>'));
    assert.deepStrictEqual(result.capabilities.diagnosticProvider, {
      interFileDependencies: false,
      workspaceDiagnostics: false
    });
    assert.strictEqual(result.capabilities.hoverProvider, true);
    assert.strictEqual(result.capabilities.definitionProvider, true);
    assert.strictEqual(result.capabilities.referencesProvider, true);
    assert.deepStrictEqual(result.capabilities.renameProvider, {
      prepareProvider: true
    });
    assert.deepStrictEqual(result.capabilities.codeActionProvider, {
      codeActionKinds: [CodeActionKind.QuickFix]
    });
    assert.strictEqual(result.capabilities.documentFormattingProvider, true);
    assert.strictEqual(result.capabilities.documentRangeFormattingProvider, true);
    assert.deepStrictEqual(result.capabilities.signatureHelpProvider, {
      triggerCharacters: ['(', ',']
    });
    assert.deepStrictEqual(result.capabilities.semanticTokensProvider, {
      legend: SEMANTIC_TOKEN_LEGEND,
      full: true
    });
    assert.ok(SEMANTIC_TOKEN_LEGEND.tokenTypes.includes(SemanticTokenTypes.function));
    assert.ok(SEMANTIC_TOKEN_LEGEND.tokenTypes.includes(SemanticTokenTypes.operator));
    assert.ok(SEMANTIC_TOKEN_LEGEND.tokenModifiers.includes(SemanticTokenModifiers.declaration));
  });

  test('converts analyzer completions to LSP completions', () => {
    const completion: AnalysisCompletionItem = {
      name: 'printf',
      kind: 'function',
      detail: 'int printf(string format, ...)',
      documentation: 'AXEL standard library output function.'
    };

    const lsp = toLspCompletionItem(completion);

    assert.strictEqual(lsp.label, 'printf');
    assert.strictEqual(lsp.kind, CompletionItemKind.Function);
    assert.strictEqual(lsp.detail, 'int printf(string format, ...)');
    assert.strictEqual(lsp.documentation, 'AXEL standard library output function.');
  });

  test('preserves include path completion insertion metadata', () => {
    const completion: AnalysisCompletionItem = {
      name: 'button.h',
      kind: 'include',
      detail: 'include path: ui/',
      insertText: 'button.h',
      filterText: 'ui/button.h',
      sortText: 'ui/button.h'
    };

    const lsp = toLspCompletionItem(completion);

    assert.strictEqual(lsp.label, 'button.h');
    assert.strictEqual(lsp.kind, CompletionItemKind.File);
    assert.strictEqual(lsp.detail, 'include path: ui/');
    assert.strictEqual(lsp.insertText, 'button.h');
    assert.strictEqual(lsp.filterText, 'ui/button.h');
    assert.strictEqual(lsp.sortText, 'ui/button.h');
  });
  for (const entry of [
    { title: 'converts analyzer diagnostics to LSP diagnostics', severity: 'error' as const, expected: DiagnosticSeverity.Error, message: 'Syntax error.' },
    { title: 'converts analyzer warnings to LSP warning diagnostics', severity: 'warning' as const, expected: DiagnosticSeverity.Warning, message: 'Warning.' }
  ]) {
    test(entry.title, () => {
      const diagnostic: AnalysisDiagnostic = { severity: entry.severity, source: 'axel', message: entry.message,
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } } };
      const lsp = toLspDiagnostic(diagnostic);
      assert.strictEqual(lsp.severity, entry.expected);
      assert.strictEqual(lsp.source, 'axel');
      assert.strictEqual(lsp.message, entry.message);
      assert.deepStrictEqual(lsp.range, diagnostic.range);
    });
  }

  test('encodes semantic tokens with relative position deltas', () => {
    const tokens: AnalysisSemanticToken[] = [
      semanticToken(1, 4, 8, 'function', ['declaration']),
      semanticToken(2, 2, 7, 'variable', []),
      semanticToken(2, 12, 16, 'macro', [])
    ];

    const lsp = toLspSemanticTokens(tokens);

    assert.deepStrictEqual(lsp.data, [
      1, 4, 4, SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf('function'), 1,
      1, 2, 5, SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf('variable'), 0,
      0, 10, 4, SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf('macro'), 0
    ]);
  });
});

function semanticToken(
  line: number,
  startCharacter: number,
  endCharacter: number,
  tokenType: AnalysisSemanticToken['tokenType'],
  modifiers: AnalysisSemanticToken['modifiers']
): AnalysisSemanticToken {
  return {
    range: {
      start: { line, character: startCharacter },
      end: { line, character: endCharacter }
    },
    tokenType,
    modifiers
  };
}
