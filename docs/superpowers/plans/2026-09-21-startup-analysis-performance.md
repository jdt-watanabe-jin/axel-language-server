# 初期解析高速化と解析キャッシュ整理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存の解析結果を維持し、指定された大規模ヘッダーの初回診断までの時間を短縮する。

**Architecture:** DocumentAnalyzerの原文・仮想ソースごとの構文データを再利用し、Tree-sitterへの重複アクセスを減らす。WorkspaceIndexの派生結果の失効を集約した後、依存元に限定して再計算する。同期・非同期APIは既存のgeneratorを共有し続ける。

**Tech Stack:** TypeScript（既存tsconfig、CommonJS）、Node.js、tree-sitter、vscode-languageserver、Mocha TDD、node:assert。

**Spec:** [承認済み設計書](../specs/2026-09-21-startup-analysis-performance-design.md)。実行時には本計画と併せて読む。

## Global Constraints

- 主な変更先はaxel-language-server。構文木そのものの誤りが判明した場合のみtree-sitter-axelで修正する。拡張側に解析ロジックを移さない。
- LSPインターフェース、設定名、既定値、公開解析APIは変更しない。診断・宣言・参照・トークンの内容とソース位置を保持する。
- 対象ワークスペースと製品ヘッダーは読み取り専用。外部ファイルの内容をテスト資産やリポジトリへコピーしない。
- 同一URI・versionでも原文、条件付き解析用ソース、マクロ展開後ソースを混同しない。
- 未完了の解析結果を完成したキャッシュとして公開しない。
- 初回診断時間の中央値を25%以上短縮することを目標にする。効果は実測値で報告し、満たさない場合は未達として残る支配的処理を示す。
- 再計測時には性能測定を並列実行しない。
- 文字コード対応の仕様変更は今回の高速化に混ぜない。
- パッケージ追加、ワーカー、永続キャッシュ、増分パース、無関係なクラス分割は行わない。
- .serena/project.ymlの既存差分を維持する。コミットは日本語のConventional Commitsとし、当該タスクのファイルだけを指定する。

## Review Focus

1. 同一version=0でディスク内容や仮想ソースが変わる場合: 古い宣言を再利用しない（Task 3）。
2. 存在しなかったinclude先が新規作成される場合: グラフに未登録でも依存元を失効させる（Task 4・5）。
3. 通常includeと条件不明のincludeが同じファイルへ到達する場合: definiteとpotentialの可視性を混同しない（Task 5）。
4. 解析を中断し、編集・設定変更後に再要求する場合: 中断時の部分結果や旧世代を公開しない（Task 3・5）。
5. 巨大ファイルの編集・closeを繰り返す場合: 古い構文木・ソースを強い参照で保持し続けない（Task 3・6）。

## 実行順序・準備

Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6。共有する解析状態が多いため、実装と性能測定は順番に行う。各タスクは独立してレビュー可能なコミットにする。

実装開始時にusing-git-worktreesスキルで作業領域を決定する。現在のサーバーはfeat/r4-operations、設計書コミットは7f38003。外部の拡張から参照されるjunctionを勝手に切り替えず、性能テストは作業領域でビルドしたout/server.jsを明示的に起動する。AGENTS.mdと各リポジトリの差分を再確認する。

以下のファイルパスはaxel-language-serverルートからの相対パス。既存テストの実行はscripts/run-tests.mjs経由とし、古いout内のテストを拾わない。

## ファイルの責務

| ファイル | 役割 |
| --- | --- |
| src/test/external/startupPerformance.test.ts（新規） | 任意の実ファイルを使う初回診断・再要求の計測 |
| src/test/support/startupMeasurement.ts（新規） | 出力比較用digestと中央値の計算 |
| src/test/unit/startupMeasurement.test.ts（新規） | 計測結果の比較ロジック |
| src/test/support/lspClient.ts（既存） | 新規プロセスの起動、任意のCPUプロファイル引数 |
| src/analyzer/cachedSyntaxNode.ts（既存） | 一つの構文木内の読み取り再利用 |
| src/analyzer/sourceSyntaxFacts.ts（新規） | 構文だけに依存する情報を遅延生成・共有 |
| src/analyzer/documentAnalyzer.ts（既存） | ソース・解析文脈・生成モードを区別した処理 |
| src/analyzer/workspaceDerivedCache.ts（新規） | URI単位の派生キャッシュの失効操作 |
| src/analyzer/workspaceIndex.ts（既存） | 依存関係と解析世代を基に失効範囲を決定 |
| docs/developer/startup-performance.md（新規） | 外部性能測定の継続利用手順 |
| docs/developer/cancellation.md（既存） | 世代管理・共有状態・rollbackの説明 |

### Task 1: 再現可能な基準値と出力比較を作る

**Files:** 上表のstartupPerformance.test.ts、startupMeasurement.ts、startupMeasurement.test.ts、lspClient.ts。新規src/test/performance/startupPipeline.test.ts。docs/developer/startup-performance.mdとREADME.mdのDevelopment節に手順とリンクを追加する。

**Interfaces:**
- Consumes: startLspServer(requestTimeoutMs = 5000)の既存request/notify/stop。
- Produces: median(values: readonly number[]): number、diagnosticDigest(items: readonly Diagnostic[]): string。
- Produces: startLspServer(requestTimeoutMs = 5000, options: {execArgv?: string[]} = {})。既存呼び出しはそのまま動作する。
- 外部テスト環境変数: AXEL_STARTUP_SAMPLE、AXEL_STARTUP_ROOT、AXEL_STARTUP_SETTINGS、AXEL_STARTUP_ENCODING（既定shift_jis）、AXEL_STARTUP_OUTPUT、AXEL_STARTUP_BASELINE。SAMPLE未指定だけをskipとし、設定不正やファイル不在は失敗させる。

- [ ] **Step 1: 比較ヘルパーのテストを先に追加する。**

startupMeasurement.test.tsにassert、Diagnostic型、対象関数をimportし、suite('Startup measurement')内に置く。

```ts
test('compares complete diagnostics independently of response order', () => {
  const a: Diagnostic = { range: { start: { line: 0, character: 1 },
    end: { line: 0, character: 2 } }, message: 'a', severity: 1 };
  const b: Diagnostic = { ...a, message: 'b' };
  assert.strictEqual(diagnosticDigest([a, b]), diagnosticDigest([b, a]));
  assert.notStrictEqual(diagnosticDigest([a]), diagnosticDigest([b]));
  assert.notStrictEqual(diagnosticDigest([a]), diagnosticDigest([
    { ...a, range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } } }
  ]));
  assert.strictEqual(median([40, 20, 30]), 30);
  assert.throws(() => median([]));
});
```

- [ ] **Step 2: 失敗を確認し、ヘルパーを実装する。**

Run: `npm run test:unit -- --grep "Startup measurement"`。最初は未作成モジュールで失敗する。

実装は次を使用する（createHashをcrypto、Diagnosticをvscode-languageserver/nodeからimport）。

```ts
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(canonical); }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
export function diagnosticDigest(items: readonly Diagnostic[]): string {
  const rows = items.map(item => JSON.stringify(canonical(item))).sort();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
export function median(values: readonly number[]): number {
  if (!values.length || values.some(value => !Number.isFinite(value))) {
    throw new Error('Expected finite measurement samples');
  }
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
```

digestは診断全体を再帰的にobjectのキー順で正規化し、診断ごとのJSON文字列をsortしてsha256化する。配列内の重複を消さない。range、severity、message、code、relatedInformation、tags、data等を落とさない。中央値は入力をコピーして数値sortし、偶数件は中央2値の平均、空入力はErrorとする。順序だけの差と内容の差を区別できることを上記テストで確認する。

- [ ] **Step 3: 実際のstdio測定を3プロセスで順に実行する外部テストを追加する。**

suite名は'External startup performance'、timeoutは600000ms。各runは次の順序を守る。

```ts
const server = startLspServer(120_000);
try {
  await server.request('initialize', {
    processId: null, rootUri: pathToFileURL(root).toString(),
    capabilities: { textDocument: { diagnostic: {} } }, configuration: settings
  });
  await server.notify('initialized', {});
  const start = performance.now();
  await server.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'axel', version: 1, text }
  });
  const first = await server.request<FullDocumentDiagnosticReport>(
    'textDocument/diagnostic', { textDocument: { uri } });
  const coldMs = performance.now() - start;
  const warmStart = performance.now();
  const warm = await server.request<FullDocumentDiagnosticReport>(
    'textDocument/diagnostic', { textDocument: { uri } });
  const warmMs = performance.now() - warmStart;
  assert.strictEqual(diagnosticDigest(first.items), diagnosticDigest(warm.items));
  samples.push({ coldMs, warmMs, digest: diagnosticDigest(first.items),
    diagnosticCount: first.items.length });
} finally {
  await server.stop();
}
```

fs、pathToFileURL、assert、performance、FullDocumentDiagnosticReport、startLspServer、median、diagnosticDigestを明示的にimportする。root、settingsは環境変数から取得し、textはnew TextDecoder(encoding, {fatal:true}).decode(fs.readFileSync(sample))とする。Code Lens/Inlay Hint refreshは既存サーバー補助と同じno-opハンドラーで受ける。

3回のdigest一致を検証する。出力JSONはschemaVersion=1、Nodeバージョン、入力バイト列とsettingsのsha256、encoding、samples、coldMedianMs、warmMedianMsを持つ。出力先は明示指定された一時ディレクトリとし、ソース本文や診断本文を保存しない。BASELINE指定時は入力・設定・encodingの一致とdiagnostic digest一致をassertし、改善率を出力する。25%は目標として報告し、共有CIの絶対時間制限にしない。

- [ ] **Step 4: 解析対象数と合成fixtureの処理回数を確認するテストを追加する。**

startupPipeline.test.tsのsuite名を'Startup pipeline'とし、useWorkspaceFixtures、WorkspaceIndex、CancellationTokenを使用する。既存loginScope.test.tsの最小GUI構文を使い、自作のGUIクラス、マクロ、段階的include、強制ヘッダー、bin/_login.axlを一時ディレクトリに生成する。実製品ソースは使わない。

```ts
const result = await index.analyzeRequestDocument(input, CancellationToken.None);
const visible = index.listVisibleDocuments(input.uri);
assert.ok(visible.some(document => document.uri === headerUri));
assert.ok(result.declarations.some(declaration => declaration.name === 'main'));
const repeated = await index.analyzeRequestDocument(input, CancellationToken.None);
assert.deepStrictEqual(repeated, result);
```

main、headerUri、inputはfixtureで作成した値とする。logger.timingからdocument.analyzeの回数と一意URI数を集計し、入れ子を含む回数であると出力に明記する。実ファイルの文書数も、LSP測定とは別の内部API補助測定でlistVisibleDocumentsを用いて確認する。これをLSPのcoldMsに合算しない。

- [ ] **Step 5: 基準値を保存し、同条件でCPUプロファイルを取得する。**

Run: `npm run test:external -- --grep "External startup performance"`。

設計書の実パスと設定JSONをPowerShellの$env:AXEL_STARTUP_*に設定し、出力を$env:TEMP配下へ保存する。3回の中央値を新しい基準値にする。従来の40.4秒は単発測定の参考値である。

lspClientのspawn引数を`[...(options.execArgv ?? []), path.resolve(__dirname, '../../server.js'), '--stdio']`にする。プロファイル用には別runで--cpu-profと一時ディレクトリを指定する。起動するのは作業領域のout/server.js。通常の3回測定にプロファイラーを混ぜない。関数ごとのself/inclusiveを分け、入れ子の時間を合算しない。

- [ ] **Step 6: ヘルパー・合成テストを成功させ、測定手順を記載してコミットする。**

Run: `npm run test:unit -- --grep "Startup measurement"`、`npm run test:performance -- --grep "Startup pipeline"`。外部パス未指定のexternalテストはskipになることも確認する。
Commit: `test: 初期解析の実測と出力比較を追加`。

### Task 2: 構文木の子ノード読み取りを再利用する

**Files:** Modify cachedSyntaxNode.ts、src/test/integration/parser/cachedSyntaxNode.test.ts、src/test/performance/syntaxSnapshot.test.ts。

**Interfaces:** cachedSyntaxNode(root: Parser.SyntaxNode): Parser.SyntaxNodeを維持する。公開オプションを追加しない。

- [ ] **Step 1: childrenを取得済みならnamedChildrenをネイティブから再取得しないテストを書く。**

```ts
test('reuses an already enumerated child array', () => {
  const root = createAxelParser().parse('int x; void f(){ x = 1; }').rootNode;
  const children = root.children;
  let namedReads = 0;
  Object.defineProperty(root, 'namedChildren', {
    configurable: true,
    get: () => { namedReads++; return children.filter(child => child.isNamed); }
  });
  const view = cachedSyntaxNode(root);
  const all = view.children;
  assert.deepStrictEqual(view.namedChildren, all.filter(child => child.isNamed));
  assert.strictEqual(namedReads, 0);
});
```

Run: `npm run test:integration -- --grep "Parse-local syntax reads"`。追加テストがnamedReads=1で失敗することを確認する。既存の配列getter回数テストは新しい契約に更新するが、意味の比較は維持する。

- [ ] **Step 2: 取得済み情報だけを使う分岐を追加する。**

Proxy.getのReflect.getより前に置く。

```ts
if (key === 'namedChildren' && values.has('children')) {
  const named = (values.get('children') as Parser.SyntaxNode[])
    .filter(child => child.isNamed);
  values.set('namedChildren', named);
  values.set('namedChildCount', named.length);
  return named;
}
```

namedChildrenしか要求されていないときはchildrenを先読みしない。child/namedChildも対応する配列が取得済みならそこから返すが、負数、範囲外、非整数についてはネイティブの挙動を比較してから分岐する。フィールド参照、範囲付きdescendantsOfTypeは既存のネイティブへの委譲を保ち、今回は独自の範囲判定を追加しない。

- [ ] **Step 3: ネイティブとの互換性を表形式のfixtureで比較する。**

有効文、未完の関数呼び出し、コメントと文字列、匿名記号、欠落ノードを含む入力それぞれでchildren/namedChildren、parent、fieldNameForChild、childForFieldName、descendantsOfTypeの単一種類・複数種類・範囲指定を既存check関数で比較する。呼び出し順children→namedChildrenと逆順を別々のfresh viewで確認する。

- [ ] **Step 4: 小規模と大規模で計測し、採用を判断する。**

Run: `npm run test:integration -- --grep "Parse-local syntax reads"`、`npm run test:performance -- --grep "Syntax snapshot traversal|Startup pipeline"`。Task 1の外部測定を実行し、ネイティブアクセス回数が減っても総時間・メモリが悪化する変更は採用しない。CPUプロファイルで別のアクセスが支配的なら、同じ互換性テストを先に追加した小変更で対処する。
Commit: `perf: 構文木の取得済み子ノードを再利用`。

### Task 3: 原文の構文情報と解析文脈を分離する

**Files:** Create sourceSyntaxFacts.ts、src/test/integration/parser/sourceSyntaxFacts.test.ts、src/test/integration/features/analysisGeneration.test.ts。Modify documentAnalyzer.ts、必要な呼び出し置換に限ってmacroReparse.ts。既存conditionalReparse.test.ts・macroReparse.test.ts・syntaxSnapshot.test.tsで検証する。

**Interfaces:**
- getSourceSyntaxFacts(root: Parser.SyntaxNode, uri: string): SourceSyntaxFacts。
- SourceSyntaxFactsのreadonly getterはmacros: ReturnType<typeof collectMacroDefinitions>、system: ReturnType<typeof collectSystemMacroSyntax>。
- SourceSyntaxFacts.typeSnapshot(replacements: readonly TypeNode[]): TypeSnapshot。既存buildTypeSnapshotを呼ぶ。
- キャッシュのルートはWeakMap<Parser.SyntaxNode, Map<string, SourceSyntaxFacts>>。rootとuriの両方を区別する。DocumentAnalyzerのclear/releaseSyntaxで既存の強いroot参照を解放する。

- [ ] **Step 1: 文脈が異なっても共有可能な構文情報だけをテストする。**

```ts
test('shares syntax facts but isolates different source trees', () => {
  const parser = createAxelParser();
  const a = cachedSyntaxNode(parser.parse('#define VALUE 1\nint a;').rootNode);
  const b = cachedSyntaxNode(parser.parse('#define VALUE 2\nint b;').rootNode);
  const first = getSourceSyntaxFacts(a, 'file:///a.axl');
  assert.strictEqual(first.macros, getSourceSyntaxFacts(a, 'file:///a.axl').macros);
  assert.notStrictEqual(first.macros, getSourceSyntaxFacts(b, 'file:///a.axl').macros);
  assert.notStrictEqual(first, getSourceSyntaxFacts(a, 'file:///other.axl'));
  assert.strictEqual(first.typeSnapshot([]), first.typeSnapshot([]));
});
```

新規テストのsuite名は'Source syntax facts'と'Analysis generation'。Run: `npm run test:integration -- --grep "Source syntax facts|Analysis generation"`。未作成モジュールによる失敗を確認する。

- [ ] **Step 2: 遅延生成する構文情報を実装し、DocumentAnalyzerから使う。**

内部は次の条件で再利用する。snapshotは完成後だけ保持する。

```ts
let previous: { replacements: readonly TypeNode[]; snapshot: TypeSnapshot } | undefined;
function typeSnapshot(replacements: readonly TypeNode[]): TypeSnapshot {
  if (previous && previous.replacements.length === replacements.length
    && replacements.every((node, i) => node === previous!.replacements[i])) {
    return previous.snapshot;
  }
  const snapshot = buildTypeSnapshot(root, uri, replacements);
  previous = { replacements: [...replacements], snapshot };
  return snapshot;
}
```

macrosとsystemはgetter内の未生成時に既存collectorを1回だけ呼ぶ。collectorの戻り値は内部の共有入力として扱い、フィルター等で新しい配列を作って意味解析へ渡す。evaluation、GUI解析、symbolIndex、highlightMacros、diagnosticsは構文のみでは決まらないので、このモジュールへ移さない。回復ノードが異なるsnapshotは再生成する。

- [ ] **Step 3: 同一version・異なるtextの誤再利用を防ぐ回帰テストを書く。**

```ts
test('does not reuse results for different text at the same version', () => {
  const analyzer = new DocumentAnalyzer();
  const uri = 'file:///disk.h';
  analyzer.analyzeDocument({ uri, version: 0, text: 'int before;' });
  const next = analyzer.analyzeDocument({ uri, version: 0, text: 'string after;' });
  assert.ok(next.declarations.some(item => item.name === 'after'));
  assert.ok(!next.declarations.some(item => item.name === 'before'));
});
```

CachedAnalysisにtext: stringを保持し、version、text、analysisContextKey、生成モードの一致でのみ再利用する。cache.setのdependenciesOnly/fullの両経路を更新する。構文世代のrootsは既存どおり実際のtextで分離する。

- [ ] **Step 4: 文脈・位置対応・中断を検証する。**

同じ原文でpreprocessorSymbolsを変えた場合、GUI既知型を変えた場合、undefを挟む再定義、マクロ引数内の参照、条件付きincludeを既存fixtureから選び、fresh DocumentAnalyzerと再利用したanalyzerの診断・宣言・参照・highlightMacrosをdeepStrictEqualする。回復ノードは同じrangeでも別内容を与えsnapshotが共有されないことをassertする。途中まで進めたgenerator.return()後に再要求し、fresh結果と比較する。

Run: `npm run test:integration`、`npm run test:performance -- --grep "Syntax snapshot traversal|Startup pipeline|Interactive analysis reuse"`。外部測定とdigest比較を実行する。
Commit: `refactor: 原文の構文情報を解析文脈から分離して再利用`。

### Task 4: 派生キャッシュの失効を一か所に集約する

**Files:** Create workspaceDerivedCache.ts、src/test/unit/workspaceDerivedCache.test.ts。Modify workspaceIndex.ts。既存includeInvalidation.test.ts、requestAnalysis.test.ts、r4WorkspaceIndexBackground.test.tsを使用する。

**Interfaces:** WorkspaceDerivedCache constructor(caches: readonly Map<string, unknown>[])、invalidate(uris?: Iterable<string>): void。WorkspaceIndex内部のcache mapは型を維持し、helperは失効だけを担当する。

- [ ] **Step 1: 指定URIだけの失効と全失効をテストする。**

```ts
test('invalidates selected entries across all registered caches', () => {
  const a = new Map<string, unknown>([['changed', 1], ['unrelated', 2]]);
  const b = new Map<string, unknown>([['changed', 3], ['unrelated', 4]]);
  const cache = new WorkspaceDerivedCache([a, b]);
  cache.invalidate(['changed']);
  assert.deepStrictEqual([...a], [['unrelated', 2]]);
  assert.deepStrictEqual([...b], [['unrelated', 4]]);
  cache.invalidate();
  assert.strictEqual(a.size + b.size, 0);
});
```

suite名は'Workspace derived cache'。Run: `npm run test:unit -- --grep "Workspace derived cache"`。失敗を確認する。

- [ ] **Step 2: 小さな失効helperを実装する。**

```ts
export class WorkspaceDerivedCache {
  constructor(private readonly caches: readonly Map<string, unknown>[]) {}
  invalidate(uris?: Iterable<string>): void {
    if (uris === undefined) {
      for (const cache of this.caches) { cache.clear(); }
      return;
    }
    const changed = [...uris];
    for (const cache of this.caches) {
      for (const uri of changed) { cache.delete(uri); }
    }
  }
}
```

Mapはfor-ofで何度も使うのでurisを一度配列化する。documentationCache、callResolutionCache、typeInputCache、semanticResultCacheを登録する。

- [ ] **Step 3: 既存の全clear操作をhelper経由に置き換える。**

このコミットでは失効範囲を変えない。deleteDocument、invalidateUri、clearCachedAnalysisの各4連clearをderivedCache.invalidate()へ置換する。analysisRollbackは既存どおりclearCachedAnalysisを経由する。builtinCatalogCacheとforcedIncludesIndexedは固有の意味を持つため、この汎用helperへ移さない。

Run: `npm run test:unit -- --grep "Workspace derived cache"`、`npm run test:integration`。
Commit: `refactor: ワークスペースの派生キャッシュ失効を集約`。

### Task 5: 依存元に限定した再計算と可視結果の再利用

**Files:** Modify workspaceIndex.ts。Create src/test/integration/workspace/derivedCacheInvalidation.test.ts、src/test/performance/visibleContextReuse.test.ts。Modify docs/developer/cancellation.md。

**Interfaces:** 公開API変更なし。内部にvisibleDeclarationsCache: Map<string, AnalysisDeclaration[]>、cachedVisibleDeclarationsCache: Map<string, AnalysisDeclaration[]>、definiteVisibleUrisCache: Map<string, string[]>を追加し、Task 4の失効helperに登録する。
内部メソッドはinvalidateDerivedFor(uris: Iterable<string>): voidとし、呼び出し元が影響範囲を決める。キャッシュ済みだけを見る経路と、login/forced includeを読み込む経路のmapを分離する。

- [ ] **Step 1: 無関係な編集で完成した結果が再利用される回帰テストを書く。**

```ts
test('keeps derived results for an unrelated open document', () => {
  const index = createWorkspaceIndex();
  const a = { uri: 'file:///a.axl', version: 1, text: 'int a;' };
  const b = { uri: 'file:///b.axl', version: 1, text: 'int b;' };
  const first = index.indexOpenDocument(a);
  index.indexOpenDocument(b);
  const tokens = index.getSemanticTokens(first);
  const context = index.callHierarchyTypeInput(first);
  index.indexOpenDocument({ ...b, version: 2, text: 'string b;' });
  assert.strictEqual(index.getSemanticTokens(first), tokens);
  assert.strictEqual(index.callHierarchyTypeInput(first), context);
});
```

suite名は'Derived cache invalidation'。Run: `npm run test:integration -- --grep "Derived cache invalidation"`。現行の全clearによりidentity比較で失敗することを確認する。

- [ ] **Step 2: 依存関係を変えるすべての書き込みを対応表にして更新する。**

workspaceIndex.tsで次を検索し、各経路を改修する。

```powershell
rg -n 'documents\.(set|delete|clear)|includeGraph\.(set|clear)|definiteIncludeGraph\.(set|clear)|loginSnapshot\s*=|\.analysis\s*=' src/analyzer/workspaceIndex.ts
```

| 書き込み・イベント | 失効対象 |
| --- | --- |
| 解析内容が変わるdocuments.set/deleteとindexed.analysisへの直接代入 | 自身とreverseIncludeGraph上の依存元 |
| 同じanalysisで完了flagだけ更新 | 新たな失効不要 |
| replaceIncludeEdges | 更新元とその依存元。辺の更新前に影響集合を取得 |
| 未解決include候補の作成・削除 | includeCandidateDependenciesとdiagnosticIncludeDependenciesから依存元を追加 |
| 設定・_login.axl・強制include・catalog変更 | 全体失効、既存の広域再解析を維持 |
| 背景解析完了 | 解析を置いたURIと依存元。未完成キャッシュを残さない |
| rollback | 派生結果を全破棄し、復元された文書から再生成 |
| close・rename | 元URIとその依存元、移動先の未解決候補依存元 |
| loginSnapshotの初回公開 | loginを参照し得る派生結果を全破棄 |

通常ファイルの変更だけならbuiltinCatalogCacheとforcedIncludesIndexedを維持する。forced includeの推移的な依存先も広域変更と判定する。これを検証できない場合は従来の広域処理を維持し、可視結果の再利用部分だけ先に完成させる。不要な失効を減らすために未知の依存を無視しない。

- [ ] **Step 3: 可視宣言とdefinite URIの計算結果を再利用する。**

listVisibleDeclarationsではensureForcedIncludesIndexedとloginの準備を済ませてからlookupし、既存sort/uniqueDeclarations結果を格納する。listCachedVisibleDeclarationsは準備を起動せず、別mapで同様に再利用する。collectDefiniteVisibleUrisも順序を維持して格納する。配列を外部呼び出し元が破壊的に変更していないかrgで確認し、既存の公開動作に必要なら公開境界ではコピーし内部共有のみ行う。

- [ ] **Step 4: 失効マトリクスと可視性をfixtureで確認する。**

各ケースで変更後のindexと同じ最新入力から作ったfresh indexを比較する。比較対象はlistVisibleDeclarationsの内容、getSemanticTokens、callHierarchyTypeInput由来の型診断。以下をderivedCacheInvalidation.test.tsの個別testにする。

- a→header、b独立: header編集でaだけ再計算。
- a→missing.h: ファイル作成後に新宣言が現れる。
- a→b→c: cの削除と再作成でaの結果も更新。
- 同じheaderへ確定includeと不確定include: definite経路が失われた後に確定宣言を残さない。
- forced headerの推移的依存先、_login.axl、targetPlatform変更: 関連結果を再生成。
- 実行中の取消→編集→再要求: fresh解析と同じ結果。
- 文書close後、同じURI/versionで異なる内容をopen: 古い結果を返さない。
- ファイルrenameで未解決候補が解決: 新しい宣言に追従。

既存のrequestAnalysis.test.ts、includeInvalidation.test.ts、fileRename.test.ts、loginScope.test.tsを参照して、キャンセルやファイルイベントを既存APIで発生させる。テスト内でproductionのprivate mapを書き換えない。

- [ ] **Step 5: 定常時の再計算回数を検証し、変更した共有状態を文書化する。**

visibleContextReuse.test.tsで、Task 1のfixtureの無変更要求を20回繰り返す。既存テストのnode:test mock.method方式で、宣言収集・sortの入力を作る処理が繰り返し実行されないことを確認する。関連先編集後は再実行されることも確認する。キャンセルの経路では結果の再利用だけで合格にせず、診断内容も比較する。

Run: `npm run test:integration`、`npm run test:performance`、`npm run test:e2e`。docs/developer/cancellation.mdのShared stateを完成した失効規則に合わせて更新する。
Commit: `perf: 依存関係に応じて可視解析結果を再利用`。

### Task 6: メモリ・実測・統合検証を完成させる

**Files:** Create src/test/performance/analysisLifetime.test.ts。Modify startup-performance.md、必要な範囲のREADME.md。他の製品ファイルは新しい失敗を修正する場合だけ変更する。

**Interfaces:** 新しい製品APIなし。テストでWorkspaceIndex.deleteDocument(uri)とDocumentAnalyzer.clear(uri)を用いて世代終了を発生させる。

- [ ] **Step 1: 編集・close後の参照保持を検証する。**

新規プロセスを--expose-gc付きで起動する任意のメモリ検証経路を追加する。大規模な合成文書の20世代を解析し、各世代で同じURIをcloseする。解析結果へのテスト側の強参照も破棄する。ヒープ値はGC後に採取する。WeakRefを利用する場合は生成したturn内で回収をassertせず、setImmediateを挟んでGCし、古い結果を保持していないことを確認する。

```ts
const result = index.indexOpenDocument({ uri, version, text });
const previous = new WeakRef(result);
index.deleteDocument(uri);
// resultのスコープを抜けた後、別turnでGCしてpreviousを調べる。
```

GC回収時刻は保証されないため、単一のderef結果を共有CIの必須条件にしない。標準CIではclose後に異なるtextを同一versionで再openしてfresh結果と一致することを必須とし、メモリ検証は前後のヒープ傾向と保持経路を確認する補助検証とする。キャッシュが旧世代を保持する場合は実装を直す。

- [ ] **Step 2: 統合テストを実行する。**

Run: `npm run test:ci`。lint、unit、integration、e2e、performanceすべての終了コードを確認する。機能を省略して時間を短縮していないことをTask 1のdigestと合成fixtureで確認する。

- [ ] **Step 3: 実ファイルを3プロセスで測定し、基準値と比較する。**

Task 1の同じ環境変数・ファイル・設定を使い、AXEL_STARTUP_BASELINEを基準JSON、OUTPUTを別ファイルにする。入力hashが変わった場合は比較せず、旧版と新版の両方を同じ入力で再測定する。中央値、改善率、warm時間、診断digest一致、内部API補助測定の文書数を記録する。

目標未達なら同条件でプロファイルし、残る支配的処理を報告する。承認済み範囲内の小修正は当該タスクへ戻して検証する。ワーカーや文法変更など新しい設計を必要とする案を無断で混ぜない。

- [ ] **Step 4: ドキュメントと最終差分を確認する。**

startup-performance.mdには再現手順、Shift_JIS入力と依存ファイルUTF-8の区別、初回診断という測定境界、CPUプロファイルと通常測定の分離を記載する。個人の実ファイル内容やログ本文は追加しない。実測数値は完了報告へ記載し、一般的な性能保証としてREADMEへ書かない。LSPや設定に変更がないことを確認し、ユーザーマニュアルは変更しない。

Run: `git diff --check`、`git status --short`。docsの相対リンクをTest-Pathで検証する。新たに失敗を修正した場合だけ関連テストを再実行し、不要に全suiteを繰り返さない。
Commit: `test: 初期解析改善の統合検証と世代解放を確認`。

## レビューと完了報告

変更をレビューし、構文互換性、失効マトリクス、キャンセル、個人データの混入、計測条件を確認する。要求された実行方式に従ってrequesting-code-reviewとverification-before-completionを使用する。push、公開、依存バージョン更新はこの計画には含めない。

完了報告は、実測の前後中央値と改善率、診断digest一致、テスト結果、変更した開発者資料、残る制限を記載する。25%目標の未達やメモリ検証の未確認を隠さない。

## 計画の自己レビュー

- 設計の構文木アクセス: Task 2。世代分離・原文情報: Task 3。
- 設計のキャッシュ失効集約: Task 4。失効範囲・可視性: Task 5。
- 再現測定・結果互換性: Task 1・6。メモリ・文書更新: Task 6。
- Review Focusの5項目は上記の該当タスクにテストを割り当てた。
- 既存のhelper名は保持し、新設の型・メソッドはInterfacesに定義した。
- 未実装の計画であり、チェックボックスは実行・検証が終わるまで完了にしない。
