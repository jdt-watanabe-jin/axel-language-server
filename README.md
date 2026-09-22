# AXEL Language Server

AXEL ソース向けの Language Server Protocol（LSP）サーバーです。[VS Code 拡張](https://github.com/jdt-watanabe-jin/axel-extension)などのクライアントから利用し、[tree-sitter-axel](https://github.com/jdt-watanabe-jin/tree-sitter-axel) による構文解析と、TypeScript で実装した意味解析を提供します。AXEL プログラム自体は実行しません。

この README は現在のソースの実装を説明します。拡張が固定参照するサーバーの `v0.1.0` と同じ機能を保証するものではありません。利用時は対応するサーバー・パーサー・クライアントのビルドを組み合わせてください。

## 対応機能

機能名と分類は [LSP 3.18 仕様](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)に合わせています。以下は実装済み機能の概要です。

### Language Features

| 機能 | できること |
| --- | --- |
| Go to Declaration / Go to Definition | シンボルの宣言・定義、include・実行ファイルの参照先へ移動 |
| Go to Type Definition / Go to Implementation | 型宣言、関数・メソッドの実装、仮想メソッドの override などへ移動 |
| Find References | 解決できたシンボルの参照箇所を検索 |
| Call Hierarchy / Type Hierarchy | 呼び出し元・呼び出し先、基底型・派生型を表示 |
| Hover / Completion / Signature Help | 可視シンボル、マクロ、組み込み宣言、継承・static メンバー、GUI 部品・イベントなどの情報表示・補完・引数支援。include・実行ファイルのパスにも対応 |
| Document Highlight / Document Link | 同一シンボルの読み書きを強調し、リテラル include・`@` によるスクリプト参照をリンク表示 |
| Document Symbol | クラス外メソッド定義や GUI イベントを含む文書の構造を表示 |
| Folding Range / Selection Range | ブロック・コメント・プリプロセッサ・region の折りたたみ、構文に沿った選択範囲の拡張 |
| Semantic Tokens | 宣言・参照・マクロ・GUI 要素などを意味に応じて色分け |
| Inlay Hint / Code Lens | 引数名ヒント、参照数・実装数を表示（どちらも既定では無効） |
| Pull Diagnostics | 構文エラー、重複宣言、未解決の名前・include・実行ファイル、型不整合、一部の GUI 誤用を検出。文書単位の診断に対応 |
| Code Action | 追加先を確定できる include の Quick Fix を提示 |
| Document Formatting / Document Range Formatting / Document on Type Formatting | 文書全体・指定範囲、改行・`}` 入力時のインデントを整形 |
| Prepare Rename / Rename | 改名可能な対象を確認し、解決できたシンボルを改名 |

### Workspace Features

| 機能 | できること |
| --- | --- |
| Workspace Symbol | 未オープンファイルを含むプロジェクト内のシンボルを検索 |
| Configuration / Did Change Configuration | クライアントから設定を取得し、変更時に再取得して反映 |
| Workspace Folders / Did Change Workspace Folders | workspace フォルダーの取得・追加・削除を解析対象に反映 |
| Did Change Watched Files | 監視対象ファイルの変更を解析・索引に反映 |
| Will Create Files / Did Create Files / Will Rename Files / Did Rename Files / Will Delete Files / Did Delete Files | 作成・改名・削除の通知で解析を更新。改名前にはリテラル include パスの更新を提案。作成前・削除前の追加編集はなし |
| Execute Command / Apply Edit | インデックス再構築、Quick Fix の適用依頼、ソース表示などを実行 |

### Window Features

| 機能 | できること |
| --- | --- |
| Show Message / Show Message Request | エラー通知や再試行・設定表示の選択肢を提示 |
| Show Document | 指定したソース位置をクライアントで開く |
| Log Message | サーバーの処理・エラーログをクライアントへ送信 |
| Work Done Progress Create / Work Done Progress Cancel | 対応クライアントに解析・検索などの進捗を表示し、キャンセルを受け付ける |

このほか、Document Synchronization の Did Open / Did Change / Did Close による文書同期（差分更新）と、Cancel Request によるリクエストのキャンセルに対応します。詳細情報の resolve や表示の refresh は、各機能とクライアントの対応状況に応じて利用します。

Doxygen 形式の先行コメント（`/** */`、`/*! */`、`///`、`//!`）から説明・引数・戻り値などを Hover、補完詳細、Signature Help に表示します。Doxygen の実行や文書生成は行いません。診断などの表示言語は `initialize.locale` が `ja` / `ja-*` なら日本語、それ以外は英語です。

### 解析範囲と制約

- include、強制 include、条件付きコンパイル、オブジェクト形式・関数形式のマクロを解析します。`tool`・`targetPlatform` に応じたシステムマクロも提供し、非アクティブ範囲は `axel/inactiveRanges` で通知します。
- `sxmHome` があれば `_login.axl` とその依存先のクラス・グローバル変数・`main` 以外のグローバル関数を共有します。起動ファイルは `axel` / `ismo` で `bin/_login.axl`、`asca` で `bin/_asca/_login.axl`、`spicechart` で `bin/_spicechart/_login.axl`。起動時の実行状態や初期値は再現しません。
- 型検査は Windows の AXEL 510 / SX-Meister 20.0.0 で検証した規則が基準です。初期化、代入、呼び出し、戻り値、演算子、条件、キャスト、ポインター、配列などを検査します。未確定の条件や回復不能な構文に依存する診断は抑制するため、診断がないことはコンパイル成功を保証しません。
- Find References・Call Hierarchy・参照数 Code Lens は現在の解析インデックスを対象とし、未オープンの全ファイルの検索を保証しません。Workspace Symbol、Go to Implementation、派生型・実装数の検索は `project` の対象ファイルも収集します。Go to Implementation・派生型用インデックスは初回要求時に構築します。
- プロジェクト検索対象は workspace 内の `.axl`・`.h`・`.hh`。workspace がなければ開いているファイルが対象です。`.git` とルート配下のシンボリックリンクは走査せず、`.gitignore` やエディターの除外設定は自動適用しません。除外した依存ファイルも型解決には使われます。
- 整形は行頭のインデントを扱い、式の空白配置などは変更しません。文書・範囲整形は構文エラーや不整合な括弧がある場合には適用しません。Rename や include 更新も曖昧な対象を推測して編集しません。
- 未保存の文書を優先します。ディスクから読み込む依存ファイルは UTF-8 として扱います。

## 利用と設定

依存関係をインストールしてビルドし、LSP クライアントから起動します。

```sh
npm install
npm run build
node out/server.js --stdio
```

クライアントは `workspace.configuration: true` を宣言する必要があります。`initialized` 後の `workspace/configuration`（`section: "axel"`）に、設定オブジェクトを1つ含む配列で応答してください。以下は配列内に入れる設定オブジェクトの例です。VS Code の設定キーとは異なります。

```json
{
  "includeRoots": [],
  "forcedIncludeFiles": ["D:/analysis/builtins.h"],
  "sxmHome": "D:/jedat/sx-meister",
  "tool": "asca",
  "project": { "exclude": ["**/generated/**"] },
  "inlayHints": { "parameterNames": { "enabled": true } },
  "codeLens": { "enabled": true }
}
```

| 主な設定 | 用途・既定値 |
| --- | --- |
| `includeRoots` | include の検索先。既定 `[]` |
| `forcedIncludeFiles` / `forcedIncludeRoots` | 強制 include のファイル／再帰収集するディレクトリ。各 `[]` |
| `sxmHome` / `defines` | 起動スクリプトの基点／追加マクロ定義。空文字列／`[]` |
| `tool` | `axel`（既定）、`ismo`、`asca`、`spicechart` |
| `targetPlatform` | 解析対象の OS・CPU。既定 `windows-x64`。選択肢は [targetPlatform.ts](src/analyzer/targetPlatform.ts) を参照 |
| `internalFeatures` | `__AXEL_INTERNAL__` の値。`enabled`（既定）で 1、`disabled` で 0 |
| `hover` / `autocomplete` | 各 `default`（有効）または `disabled` |
| `errorSquiggles` | `enabledIfIncludesResolve`（既定）、`enabled`、`disabled`。既定では依存 include が解決しない文書は include 解決エラーのみ表示 |
| `maxNumberOfProblems` | 診断件数の正の上限値。省略時は上限なし |
| `project.include` / `project.exclude` | 共通のプロジェクト検索範囲。`["**/*"]`／`[]`。相対パスで `/` 区切りの `*`・`?`・`**` に対応 |
| `workspaceSymbols` | Document Symbol の表示モード。既定 `Just My Code`、または `All`。Workspace Symbol の検索範囲は `project` で指定 |
| `inlayHints.parameterNames.enabled` | 引数名ヒント。既定 `false`。同階層の `suppressWhenArgumentContainsName` は既定 `true` |
| `codeLens.enabled` | 参照数・実装数の表示。既定 `false` |
| `fileOperations.updateIncludesOnRename` | ファイル改名時の include 更新。既定 `true`。編集の適用・ファイル移動はクライアントが実施 |

設定は接続単位の完全なスナップショットで、省略項目は既定値に戻ります。変更時は `workspace/didChangeConfiguration` を通知し、再取得後に再起動なしで反映します。通知の設定ペイロードや環境変数は代替設定元になりません。不正値・取得失敗時は設定が利用不能となり、再取得に成功するまで設定を必要とする言語要求が失敗します。旧 `workspaceSymbols.exclude`・`fileOperations.exclude` は使用できません。

外部ヘッダーや解析用 JSON の変更も `workspace/didChangeWatchedFiles` で通知してください。起動スクリプトの監視対象は `axel/loginDependencies` で通知します。更新・追加表示・ファイル操作の利用には、それぞれ対応するクライアント機能が必要です。

### 組み込み API の解析用宣言

解析専用の宣言ヘッダーは `forcedIncludeFiles` に登録し、隣に同名の `.analysis.json`（例: `builtins.h` → `builtins.analysis.json`）を配置します。

```json
{
  "schemaVersion": 1,
  "profile": "axel-510",
  "declarationFiles": ["builtins.h"],
  "types": {},
  "analysisOnlyMacros": []
}
```

`declarationFiles` に解析専用として扱うファイルを明示し、必要に応じて `types` に組み込み型と宣言元の対応を登録します（[スキーマと検証処理](src/analyzer/typeChecking/builtinCatalog.ts)）。ファイルは JSON の配置先配下にある必要があります。強制 include に追加するだけでは、組み込み型の特殊規則や解析専用プロトタイプの許可は有効になりません。

## 性能の目安

2026-09-22 の既存測定結果です。Windows x64 / Node.js v25.8.1 で独立したプロセスで3回計測した中央値を示します（RSS は別計測）。

| 対象・処理 | 実測値 |
| --- | ---: |
| 実 SXM_USERHOME：17,272 行・約 564 KB のヘッダーと起動スクリプト・強制 include を含む初回診断 | 約 20.49 秒 |
| 同じ文書を変更せず直後に再診断 | 約 3.40 ms |
| 同 SXM_USERHOME 条件の最大 RSS（別の単発測定、プロセス全体） | 約 2.35 GB |
| 合成ソース：4,000 宣言の文書解析 | 約 282 ms |
| 同合成ソースの編集・再解析 5 回の合計 | 約 1.41 秒 |

実 SXM_USERHOME は `tool: asca`、`errorSquiggles: enabled` で計測。対象ヘッダーは Shift_JIS でデコードし、ディスク上の依存ファイルは通常の UTF-8 読み込みを使用しました。初回は `didOpen` から最初の診断応答までで、プロセス起動・VS Code 描画・全バックグラウンド処理の完了を含みません。OS のファイルキャッシュは消去していません。合成ケースは Ryzen 5 PRO 8600GE 上の解析 API の計測で、LSP 往復時間ではありません。

大規模 SXM_USERHOME では初回の依存解析に時間とメモリを要し、変更のない再要求にはキャッシュが有効です。解析は協調的に分割されますが、ネイティブ parse など同期処理も残るため応答時間の上限は保証しません。Tree-sitter の incremental parsing と意味解析の差分更新は未導入です。上記は特定入力での参考値であり、任意の大規模 workspace や編集時の速度を保証するものではありません。

## 開発・検証

```sh
npm test                  # unit・integration・LSP の E2E（ビルドを含む）
npm run test:ci           # lint と上記テスト、性能回帰テスト
npm run benchmark        # 合成ケースを3プロセスで計測し JSON を標準出力
```

実 SXM_USERHOME などローカル環境を要する検証は `npm run test:external` で実行します。必要な環境変数は [外部テスト](src/test/external) を参照してください。合成ベンチマークの実行コードは [scripts](scripts)、性能回帰テストは [src/test/performance](src/test/performance) にあります。

実装は [src/lsp](src/lsp) が LSP の窓口、[src/analyzer](src/analyzer) が解析と索引管理を担当します。AXEL 構文・構文木の変更は `tree-sitter-axel`、エディター固有の UI は VS Code 拡張で扱います。
