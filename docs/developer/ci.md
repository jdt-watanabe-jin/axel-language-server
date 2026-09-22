# CI と依存関係の検証

CI は `tree-sitter-axel` と同じ Ubuntu・macOS・Windows の最新ランナーと Node.js 22・24 の6組み合わせで、`npm ci` と `npm run test:ci` を実行します。

ネイティブ依存関係のビルドには、パーサーと同じ `node-gyp` 13.0.2 系を開発依存として指定しています。開発には Node.js 22.22.2 以降の22系、または24.15.0以降の24系を使用してください。Windows では Visual Studio の C++ ビルドツールと Python が必要です。

`tree-sitter-axel` は `package.json` でタグ `v0.1.0` を参照し、`package-lock.json` で実際のコミットを固定します。パーサーの構文や構文木に依存する変更では、必要なパーサー修正とタグを公開した後、ロックファイルの参照先も更新してください。タグを付け替えただけでは `npm ci` の参照先は変わりません。ローカルのリンク先だけを更新すると、クリーンインストールした CI と解析結果が異なります。

型検査の実機証跡を含む `src/test/integration/fixtures/type-checking/**/*.axl` は、記録された SHA-256 と同じバイト列を維持するため `.gitattributes` で CRLF に固定しています。ハッシュ検証を省略したり、改行差だけを理由に証跡のハッシュを書き換えたりしないでください。
