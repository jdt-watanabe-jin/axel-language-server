import {
  CodeActionKind,
  type InitializeResult,
  TextDocumentSyncKind
} from 'vscode-languageserver/node';
import { SEMANTIC_TOKEN_LEGEND } from './semanticTokens';

const COMPLETION_TRIGGER_CHARACTERS = [
  '.',
  ':',
  '"',
  '<',
  '#',
  '@',
  '/',
  '\\',
  '>',
  '_',
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
];

export function createInitializeResult(): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      inlayHintProvider: true,
      completionProvider: {
        triggerCharacters: COMPLETION_TRIGGER_CHARACTERS
      },
      signatureHelpProvider: {
        triggerCharacters: ['(', ',']
      },
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: {
        prepareProvider: true
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix]
      },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      callHierarchyProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: {
        legend: SEMANTIC_TOKEN_LEGEND,
        full: true
      },
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false
      }
    }
  };
}
