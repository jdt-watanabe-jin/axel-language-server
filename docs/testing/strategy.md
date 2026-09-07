# AXEL Language Server テストガイド

## 構成と責務

テストフレームワークはMocha。TDD UIの `suite` / `test` を使用する。

```text
src/test/
  unit/                  # モデル、マクロ展開、設定、LSP変換、注入境界の配線・失敗応答
  integration/
    parser/              # 実Tree-sitter → AST利用者（symbol/scope/GUI/macro/構文診断）
    workspace/           # 文書cache、include探索・可視性・更新・背景索引
    features/            # AXEL入力 → Hover/補完/意味診断/定義/参照/rename等
    lsp/                 # 実解析を伴うLSP境界
    fixtures/            # Integrationの共有AXEL入力と期待値
    fixture.ts           # 上記データのパス解決
  e2e/                   # 実server.jsをstdio起動し、JSON-RPCの入出力を検証
  performance/           # 処理件数・lookup回数・実行時間を検証
  external/              # 外部の実データ・include環境との互換性を確認
  support/               # 入力、解析、索引、後始末、stdioクライアント
```

Regressionはテストの目的であり、独立した実行レイヤーではない。回帰を防ぐ仕様を所有するレイヤーに配置する。

Parser自身の文法受理・優先順位・ERROR木の正しさは `tree-sitter-axel` のcorpusが主担当。`integration/parser` はサーバーが依存するノード名・range・抽出結果を保証する。文法を模倣するモックParserは追加しない。

Unitは関数または注入境界の契約を検証する。`registerHandlers` のエラー注入・ログ受信・背景完了通知には境界スタブを使う。実Parserを呼ぶformatting配線などは `integration/lsp` に置く。ハンドラのUnitもimportを通じてnative Parserパッケージをロードするため、依存パッケージのインストールは必要。

E2Eは実サーバーの起動、文書ライフサイクル、通信による連携に絞る。機能の細かい入力バリエーションはIntegrationで検証する。VS Code UIの検証は拡張機能リポジトリが担当する。

## TDDで追加するときのルール

1. 「どんな不具合ならこのテストが失敗するか」を明確にする。過去のバグは必要ならissue/commitと最小再現をコメントやfixture READMEに残す。
2. 変更を所有する層に、最小の観測可能な期待値で失敗するテストを追加する。正常系は可能なら実Parserと実解析器を使い、エラー注入のスタブは境界に限定する。
3. 同じ入力でも層ごとの期待値が違えば残す。例えばscope抽出と補完では、解析モデルと候補の可視性をそれぞれ保証する。同じ契約の入力バリエーションは名前付きテーブルにまとめる。
4. range、型、候補の包含・除外、順序など利用者に見える契約を優先する。内部関数の呼び順や全内部オブジェクトのsnapshotに依存しない。期待値を対象の実装で計算しない。
5. 各ケースでParser / DocumentAnalyzer / WorkspaceIndexを新規作成する。ファイルやWorkspaceIndexが必要なら `useWorkspaceFixtures` を使う。背景索引は `waitForBackgroundIndexing` で待ち、固定sleepや他テストの解析結果を前提としない。
6. helperはセットアップと後始末を担当する。機能の期待値や万能モックを隠さず、テストから意図が読めるようにする。
7. 回復入力は単に例外が出ないことだけでなく、可能なら回復後の応答内容まで検証する。
8. テストを移動・統合するときは、既存の期待値がどのケースに残るか確認する。「現在通っている」ことを削除理由にしない。
9. 修正前の再実行や一時的な失敗注入で、重要な回帰を実際に検知できることを確かめる。

## テスト入力とfixture

小さい再現はインラインに書く。長い入力や複数テストが共有するデータは、共有する最小の範囲のfixturesに置く。`features` は機能のテストコード、`fixtures` は入力データと期待値を置くディレクトリ。

短い入力の照会位置には `support/source.ts` の `|` マーカーを使える。最初の `|` をマーカーとして扱うので、それより前に演算子 `|` を含む入力はoffset指定にする。実コードfixtureではsource/tokenで照会位置を特定し、期待値との対応を明示する。

fixture変更時は全利用者を検索し、関連するテストを実行する。入力データは読み取り専用で共有し、解析器・索引・結果は共有しない。

## ローカライズ

`unit/localization.test.ts` は辞書の引数整合、ネストした説明文、翻訳欠落時の英語フォールバック、組み込み関数の説明とシグネチャ保持を検証します。診断の integration テストでは構文・意味・マクロの診断と引数数の表現を確認します。定義元・クイックフィックスの既存テストにも日本語の場合を含めています。

`e2e/localization.test.ts` は本番サーバーを stdio で起動し、`initialize.locale` に `ja`、`ja-JP`、`en`、未対応言語、未指定を渡します。診断、ホバー、補完、設定変更後の言語保持を応答で確認します。テストクライアントはサーバーからの診断・semantic tokens 更新要求にも応答します。

翻訳対象は生成した説明文です。ソースコメント、識別子、パス、シグネチャ、編集内容を翻訳しないことも確認してください。

## 実行

| 用途 | コマンド |
| --- | --- |
| 単体の短い反復 | `npm run test:unit` |
| 普段のTDD（Unit＋Integration） | `npm run test:fast` |
| Integration全体 | `npm run test:integration` |
| 機能を絞る | `npm run test:integration -- --grep getCompletions` |
| TypeScript編集を監視して再ビルド・実行 | `npm run test:watch` |
| LSPライフサイクル | `npm run test:e2e` |
| 性能回帰 | `npm run test:performance` |
| コミット前の全標準テスト | `npm test` |
| CI相当（lint＋全標準テスト） | `npm run test:ci` |
| 実環境groupbox | `npm run test:external` |
| 実環境も含む完全確認 | `npm run test:complete` |

各テストコマンドは先にtscを実行する。`scripts/run-tests.mjs` はsrc側に現存する `*.test.ts` から対象を選び、Mochaを起動する。移動・削除前のoutが残っていても実行しない。reporterやgrepなどの引数はMochaへ渡す。

watchはNodeの `--watch-path` を使う。利用するNodeとOSがこのオプションに対応している必要がある。高速モードは性能・E2Eを省略するが、`npm test` / `test:ci` は両方を含める。

性能を測るときは、Mochaの時間とビルド込みの時間を区別する。CIの負荷によって性能上限に達した場合は、実測と処理量を調査し、安易に上限を緩めない。

Externalは `AXEL_TEST_SAMPLE` と `AXEL_TEST_FORCED_INCLUDE` で実データのパスを指定できる。未指定時の開発環境パスは `external/groupbox.test.ts` を参照。明示実行で入力が欠けている場合はskipせず失敗する。標準CIは同梱fixtureで回帰検証し、実データ互換性は利用可能な環境で別途確認する。
