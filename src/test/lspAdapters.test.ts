import * as assert from 'assert';
import {
  CodeActionKind,
  CompletionItemKind,
  DiagnosticSeverity,
  DocumentDiagnosticReportKind,
  Location,
  SemanticTokenModifiers,
  SemanticTokenTypes,
  SymbolKind,
  TextDocumentSyncKind
} from 'vscode-languageserver/node';
import { createInitializeResult } from '../lsp/capabilities';
import { toLspCompletionItem } from '../lsp/completion';
import { toDocumentDiagnosticReport, toLspDiagnostic } from '../lsp/diagnostics';
import { toLspDocumentSymbol } from '../lsp/documentSymbols';
import { toLspLocations } from '../lsp/navigation';
import { toLspCodeActions } from '../lsp/codeActions';
import { toLspWorkspaceEdit } from '../lsp/rename';
import { toLspSignatureHelp } from '../lsp/signatureHelp';
import { toLspTextEdits } from '../lsp/formatting';
import { SEMANTIC_TOKEN_LEGEND, toLspSemanticTokens } from '../lsp/semanticTokens';
import type {
  AnalysisCompletionItem,
  AnalysisCodeAction,
  AnalysisDiagnostic,
  AnalysisSignatureHelp,
  AnalysisSemanticToken,
  AnalysisSymbol
} from '../types/analysis';

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

  test('converts analyzer signature help to LSP signature help', () => {
    const signatureHelp: AnalysisSignatureHelp = {
      signatures: [{
        label: 'void foo(int count, string name)',
        parameters: [
          { label: 'int count' },
          { label: 'string name' }
        ]
      }],
      activeSignature: 0,
      activeParameter: 1
    };

    const lsp = toLspSignatureHelp(signatureHelp);

    assert.deepStrictEqual(lsp, {
      signatures: [{
        label: 'void foo(int count, string name)',
        parameters: [
          { label: 'int count' },
          { label: 'string name' }
        ]
      }],
      activeSignature: 0,
      activeParameter: 1
    });
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

  test('converts analyzer diagnostics to LSP diagnostics', () => {
    const diagnostic: AnalysisDiagnostic = {
      severity: 'error',
      source: 'axel',
      message: 'Syntax error.',
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 4 }
      }
    };

    const lsp = toLspDiagnostic(diagnostic);

    assert.strictEqual(lsp.severity, DiagnosticSeverity.Error);
    assert.strictEqual(lsp.source, 'axel');
    assert.strictEqual(lsp.message, 'Syntax error.');
  });

  test('converts analyzer warnings to LSP warning diagnostics', () => {
    const diagnostic: AnalysisDiagnostic = {
      severity: 'warning',
      source: 'axel',
      message: 'Warning.',
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 4 }
      }
    };

    const lsp = toLspDiagnostic(diagnostic);

    assert.strictEqual(lsp.severity, DiagnosticSeverity.Warning);
  });

  test('wraps diagnostics in a full document diagnostic report', () => {
    const report = toDocumentDiagnosticReport([]);

    assert.strictEqual(report.kind, DocumentDiagnosticReportKind.Full);
    assert.deepStrictEqual(report.items, []);
  });

  test('converts analyzer symbols to LSP document symbols', () => {
    const symbol: AnalysisSymbol = {
      name: 'main',
      kind: 'function',
      detail: 'function',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 14 }
      },
      selectionRange: {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 9 }
      }
    };

    const lsp = toLspDocumentSymbol(symbol);

    assert.strictEqual(lsp.name, 'main');
    assert.strictEqual(lsp.kind, SymbolKind.Function);
    assert.strictEqual(lsp.detail, 'function');
  });

  test('converts operator analyzer symbols to LSP operators', () => {
    const symbol: AnalysisSymbol = {
      name: 'operator++',
      kind: 'operator',
      detail: 'operator',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 16 }
      },
      selectionRange: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 14 }
      }
    };

    const lsp = toLspDocumentSymbol(symbol);

    assert.strictEqual(lsp.name, 'operator++');
    assert.strictEqual(lsp.kind, SymbolKind.Operator);
    assert.strictEqual(lsp.detail, 'operator');
  });

  test('converts enum member analyzer symbols to LSP enum members', () => {
    const symbol: AnalysisSymbol = {
      name: 'A',
      kind: 'enumMember',
      detail: 'enum Mode::A',
      range: {
        start: { line: 0, character: 12 },
        end: { line: 0, character: 13 }
      },
      selectionRange: {
        start: { line: 0, character: 12 },
        end: { line: 0, character: 13 }
      }
    };

    const lsp = toLspDocumentSymbol(symbol);

    assert.strictEqual(lsp.name, 'A');
    assert.strictEqual(lsp.kind, SymbolKind.EnumMember);
    assert.strictEqual(lsp.detail, 'enum Mode::A');
  });

  test('converts analyzer locations to LSP locations', () => {
    const locations = toLspLocations([{
      uri: 'file:///main.axl',
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 6 }
      }
    }]);

    assert.deepStrictEqual(locations, [
      Location.create('file:///main.axl', {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 6 }
      })
    ]);
  });

  test('converts analyzer text edits to LSP text edits', () => {
    const edits = toLspTextEdits([{
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 2 }
      },
      newText: '    '
    }]);

    assert.deepStrictEqual(edits, [{
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 2 }
      },
      newText: '    '
    }]);
  });

  test('converts analyzer workspace edits to LSP workspace edits', () => {
    const edit = toLspWorkspaceEdit({
      changes: {
        'file:///main.axl': [{
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 7 }
          },
          newText: 'renamed'
        }]
      }
    });

    assert.deepStrictEqual(edit, {
      changes: {
        'file:///main.axl': [{
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 7 }
          },
          newText: 'renamed'
        }]
      }
    });
  });

  test('converts analyzer code actions to LSP code actions', () => {
    const diagnostic: AnalysisDiagnostic = {
      severity: 'error',
      source: 'axel',
      message: "Unknown type 'Widget'.",
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 6 }
      }
    };
    const action: AnalysisCodeAction = {
      title: 'Add include "types.h"',
      kind: 'quickfix',
      diagnostics: [diagnostic],
      edit: {
        changes: {
          'file:///main.axl': [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: '#include "types.h"\n'
          }]
        }
      }
    };

    assert.deepStrictEqual(toLspCodeActions([action]), [{
      title: 'Add include "types.h"',
      kind: CodeActionKind.QuickFix,
      diagnostics: [toLspDiagnostic(diagnostic)],
      edit: toLspWorkspaceEdit(action.edit)
    }]);
  });

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
