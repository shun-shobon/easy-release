# 内部設計

リリースの実行順序、業務上の判定、外部システムとの接続を分離します。具体的な実装は `src/index.ts` で組み立て、コンストラクターや引数で渡します。

| 層         | 責務                                                                                         | 依存先                                                         |
| ---------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `usecases` | prepare / draft / publish の実行順序とイベントの適用条件                                     | サービスの公開操作、アプリケーションの型、純粋なユーティリティ |
| `services` | タグからの現在版の決定、準備 PR の置き換え、ドラフトの再利用、公開条件、共通バージョンの更新 | 同層のサービス、外部 I/O の契約、`utils`                       |
| `infra`    | GitHub・Git・ファイルシステム・Actions イベントとの接続                                      | サービスが定義した契約、SDK、Node.js API                       |
| `utils`    | 副作用のないバージョン判定と計算                                                             | `semver`                                                       |

`usecases` と `services` は `infra` の実装を import しません。`services/definitions.ts` の `ReleaseRepository`、`Workspace`、`PackageFileStore` を infra が実装することで、サービスから実装への依存を避けます。lint でも両層から infra、Node.js API、Octokit、Actions SDK の import を禁止します。

## モジュールの役割

- `usecases/prepare.ts` は準備 PR 作成までの順序を制御します。
- `usecases/draft.ts` は対象イベントを判定し、マージ結果の検証とドラフト作成を組み合わせます。
- `usecases/publish.ts` は指定済みリリースの公開をサービスへ依頼します。マージからの公開では draft のイベント判定・マージ検証・ドラフト作成を再利用し、その結果を公開処理へ渡します。対象外の PR や途中の失敗では公開しません。各 usecase は必要なサービス操作だけに依存し、HTTP パスや GitHub の応答スキーマは扱いません。
- `services/releases.ts` はタグ一覧から現在版を決め、PR・タグ・リリースの状態を判定します。変更コミットを保存してから前の PR を閉じ、全アセットを確認してから公開します。
- メジャー・マイナータグの更新が有効な場合、`services/releases.ts` は公開前にタグ名を検証し、公開成功後に存在確認と作成・更新を順に実行します。既存タグの移動は `ReleaseRepository.updateTag` に依頼し、`infra/github.ts` が `rest.git.updateRef` を `force: true` で呼びます。未存在の場合は既存の `createTag` を使います。
- `services/preparation.ts` はタグ由来の現在版を増分し、checkout、ファイル更新、更新コマンド、最終検証を組み合わせます。検証後の変更一覧が空でも準備を継続します。マージ時の予定版は準備ブランチ名から取得します。
- `services/packages.ts` は JSON を検証して指定された共通版を書き込み、更新後の版を確認します。ファイルの選択・読み書きは `PackageFileStore` に依頼します。
- `infra/github.ts` は Octokit の `rest.git`、`rest.pulls`、`rest.repos` の API 別メソッドを呼びます。認証、タイムアウト、ページ送り、応答の契約型への変換をここで行います。
- `infra/workspace.ts` と `infra/package-files.ts` は Git・Bash・ファイル操作を実装します。更新コマンドに独自の制限時間は設けず、終了結果と出力上限を確認します。Git の変更はバイナリや削除も含めて `FileChange` として渡します。
- `infra/action-input.ts` は publish の3入力を検証します。すべて省略した場合はマージからの公開、すべて指定した場合は既存ドラフトの公開を選び、一部だけの指定は拒否します。`src/index.ts` は全モードで設定を読み込み、この判定に従ってマージからの公開に必要なイベントを読み込み、checkout の検証を実行します。
- `infra/action-event.ts` は GitHub のイベント JSON からリポジトリのデフォルトブランチを取得し、ユースケース向けの `ReleaseEvent` に変換します。
- `utils/version.ts` は `semver.parse`、`semver.gt`、`semver.inc` を使用します。安定版 `X.Y.Z` のみを認める制約を、その解析結果に対して適用します。
- `utils/version.ts` の `versionTags` は接頭辞を取り除いた安定版を検証し、semver の major / minor から更新する2つのタグ名を生成します。

## 境界と検証

Action のログ・エラーと生成する PR・コミットの文面は英語です。準備コミットの文面は `services/release-names.ts` で生成し、作成と既存ブランチの識別に共通で使います。

設定・環境変数・Action 入力・イベント JSON・package.json は Valibot、バージョンは semver で検証します。Octokit の応答には SDK の型を使用し、スキーマによる再検証は行いません。コミット識別子は空でない文字列として扱い、形式の正規表現では検証しません。GitHub 固有のフィールド名は infra でアプリケーションの型に変換します。Git の参照先はリリース対象として扱える commit または tag に限定します。

GitHub の各操作は Octokit の API 別メソッドを直接呼びます。通信のタイムアウトと応答本文を含めないエラーへの変換は Octokit の request hook に集約します。タグ・PR・リリース・アセットの一覧には API 別メソッドを渡した `octokit.paginate` を使い、各ページの応答を契約型へ変換します。

ユースケースのテストはサービスの操作だけを差し替え、実行順序と失敗後の停止を検証します。サービスのテストはストレージやリポジトリの契約を差し替えて判定を確認します。infra のテストは Octokit の通信先や一時ファイルを使い、SDK・Git・ファイル境界を検証します。結合テストではこれらの層をつなぎ、準備 PR から公開までの動作を確認します。

## 配布とジョブ間の連携

アセット添付を行う構成では、draft と publish の間に利用側のビルド・アセット添付が入るため、`release-id`、`tag`、`commit` を明示的に受け渡します。publish は API 上の状態を再検証します。全ビルドの完了は利用側のステップ順序またはジョブ間の `needs` で制御し、共通 Action には Docker や各言語のビルド手順を組み込みません。

アセット添付を行わない構成では prepare → publish を使用できます。publish の3入力を省略し、準備 PR のマージコミットを checkout します。内部ではドラフト作成から公開まで連続して実行し、`ready` と `version` も出力します。必要なビルドや検証は publish の前に完了させます。

`src/index.ts` は全モードの分岐前に、`config` 入力が指す設定ファイルを読み込み、`services/config.ts` のスキーマで検証します。publish は draft の有無にかかわらず、設定の `updateVersionTags` が有効なら `tagPrefix` をサービスへ渡し、無効ならタグ更新設定を渡しません。公開後のタグ更新で失敗しても、公開済み状態や更新済みタグは巻き戻しません。

配布時は tsdown で実行時依存を `dist/index.mjs` に束ねます。`action.yml` はそのファイルを直接実行します。

ローカルモジュールの import は拡張子を省略します。TypeScript は `moduleResolution: bundler` で解決し、実行用ファイルは tsdown でバンドルします。

このリポジトリの `.github/workflows/release.yml` は `uses: ./` で自身の Action を実行します。prepare は共通 setup で依存関係を準備し、`.github/easy-release.json` に従ってバージョン更新と `pnpm format` を行います。準備 PR のマージ後はマージコミットを checkout し、リリース入力を省略した publish を実行して、タグ上の `action.yml` と `dist/index.mjs` を配布します。

変更一覧が空の場合、`infra/github.ts` は blob と tree の作成を省略し、親コミットの tree をそのまま指定して準備コミットを作成します。ブランチと PR の作成は差分がある場合と同じ処理です。実際の Git リポジトリを使って空の変更一覧を検証し、HTTP 境界のテストで親の tree を使った空コミットから PR 作成までを確認します。

## CI

`.github/actions/setup` は mise-action によるツールの自動インストールと pnpm の依存関係を準備する composite Action です。`ci` workflow は checkout 後にこの Action を呼び、format・lint・type-check・test・diff-check を独立したジョブで実行します。diff-check はビルドによる `dist` の差分を検出します。

stats-check は5ジョブを `needs` に指定し、`always()` で失敗・キャンセル・スキップも含む結果を確認します。すべてが success の場合に限り成功します。
