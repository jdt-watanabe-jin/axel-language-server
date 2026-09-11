# GUI回帰fixture

`hover-regression.axl` は、GUI部品の入れ子、暗黙receiver、継承メソッドと通常の局所変数を含む自己完結したAXEL入力です。外部SDKや個人環境のincludeを必要としません。

利用するテスト：

- `../features/guiHoverRegression.test.ts`：`hover-regression.expected.json` の各位置を一つのテスト・解析で確認します。`source` は入力中の文、`token` はその文内の照会位置、`expected` は期待するHover先頭行です。

実groupboxサンプルと外部includeの互換性は `../../external/groupbox.test.ts` で別途確認します。

変更時はGUI hover回帰テストを実行してください。読み取り専用の入力だけを共有し、解析器・WorkspaceIndex・結果は各テストで新規作成します。
