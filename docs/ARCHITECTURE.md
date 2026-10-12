# 内部設計

本 Action では、リリースの実行順序（ワークフロー制御）、業務ロジック（判定処理）、外部システムとの接続（I/O）を疎結合に分離しています。具象クラスのインスタンス化や依存性の注入（DI）は、エントリポイントである `src/index.ts` に集約しています。挙動の仕様は [SPEC.md](SPEC.md) を参照してください。

| レイヤー   | 責務                                                                                                               | 依存先                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `usecases` | prepare / draft / publish の各モードにおける処理順序の制御と、イベント適用条件の検証                               | サービスの公開操作、アプリケーションの型定義、副作用のないユーティリティ関数 |
| `services` | タグからの現在バージョンの算出、準備 PR のクローズ・再作成、ドラフトの再利用、公開可否の判定、共通バージョンの更新 | 同一レイヤーのサービス、外部 I/O の契約（インターフェース）、`utils`         |
| `infra`    | GitHub API・Git・ファイルシステム・GitHub Actions イベントとの接続                                                 | サービスが定義した契約、SDK、Node.js 組み込み API                            |
| `utils`    | 副作用のないセマンティックバージョンの計算と、共通の Valibot スキーマ                                              | `semver`、`valibot`                                                          |

`usecases` および `services` は、`infra` の具象クラスを直接 import しません。`services/definitions.ts` で定義されたインターフェース（`ReleaseRepository`、`Workspace`、`PackageFileStore`）を `infra` が実装することにより、依存関係逆転の原則（DIP）を適用しています。Oxlint のルールにおいても、これら上位レイヤーから `infra`、Node.js 組み込み API、Octokit、Actions SDK を直接 import することを禁止しています。

## モジュールの役割

- `index.ts`: 入力・環境変数・設定ファイルを検証し、具象実装を組み立てます。`release-id`・`tag`・`commit` が指定された publish では `ReleaseService.publish` を直接呼び出し、それ以外は各 usecase に処理を委ねます。
- `usecases/prepare.ts`: ベースコミットとタグからバージョンを確定し、`PreparationService.plan` で checkout と ref 名を検証します。タグが未使用であることを確認してから `PreparationService.apply` でファイルを書き換えるため、ファイル変更は検証がすべて通った後にのみ発生します。
- `usecases/draft.ts`: PR イベントと準備ブランチ名からリリース対象かを判定し、ブランチ名から取得したバージョンでマージ結果を検証してドラフトを作成します。
- `usecases/publish.ts`: draft の判定・検証・ドラフト作成を再利用し、その結果をもとに公開処理へ進みます。
- `services/release-names.ts`: タグ名・準備ブランチ名・準備コミットメッセージの生成と、準備ブランチ名からのバージョン抽出を一元化します。準備コミットメッセージは、既存ブランチが前回の準備コミットであるかの識別にも使用します。
- `services/preparation.ts`: checkout 済みの作業ツリーに対する準備処理（バージョン算出と ref 検証、ファイル更新・更新コマンド実行・変更収集）と、マージ時点のパッケージ検証を担います。
- `services/packages.ts`: 対象ファイルのバージョンを検証し、全ファイルの書き換え内容を確定してから共通バージョンを書き込みます。ファイルの検索・読み書きは `PackageFileStore` を通じて行います。
- `services/package-formats.ts`: ファイル名から JSON / Cargo マニフェストの形式を選び、形式ごとのバージョン読み取りと書き換えを実装します。Cargo マニフェストは `toml-eslint-parser` で位置情報付きの AST に変換し、キーパスで特定した `version` の値ノードの範囲だけを置換します。
- `services/releases.ts`: タグ一覧から現在のバージョンを決定し、PR・タグ・リリースの状態判定と作成・公開を行います。メジャー・マイナータグの更新では、既存タグは `ReleaseRepository.updateTag`（`rest.git.updateRef` を `force: true` で呼び出し）、未作成のタグは `createTag` を使用します。
- `infra/github.ts`: Octokit の API 別メソッドを呼び出し、レスポンスをドメイン契約型へ変換します。
- `infra/workspace.ts`: `GitWorkspace` が Git コマンドと Bash による更新コマンドの実行を実装します。変更差分は `git diff --cached --raw` の 1 回の呼び出しから旧・新ファイルモードとステータスを取得し、`FileChange` に変換します。
- `infra/package-files.ts`: パッケージファイルの glob 展開とパス制約の検証、読み書きを実装します。
- `infra/action-input.ts`: publish モードの 3 つの入力（`release-id`、`tag`、`commit`）が「すべて省略」か「すべて指定」のいずれかであることを検証します。
- `infra/action-event.ts`: イベント JSON をユースケースで扱う `ReleaseEvent` 型に変換します。
- `utils/version.ts`: `semver` をラップし、安定版 `X.Y.Z` のみを受け付ける制約を適用します。
- `utils/schema.ts`: 複数レイヤーで共有する Valibot スキーマを定義します。

## 境界と検証

設定ファイル、環境変数、Action の入力パラメータ、イベント JSON、パッケージファイルは Valibot でバリデーションし、バージョン文字列は semver で検証します。Octokit のレスポンスには SDK 提供の TypeScript 型をそのまま利用し、スキーマによる再検証や、リクエストした値がそのまま返却されたかの照合は行いません。GitHub 固有のプロパティ名は、infra 層においてアプリケーション固有の型へとマッピングされます。

通信タイムアウトの設定や、レスポンス本文を含まない安全なエラーへの変換処理は、Octokit の request hook に集約しています。一覧取得には `octokit.paginate` を用います。

ユースケース層のユニットテストでは、サービス層の操作をモックに差し替え、処理の実行順序やエラー発生時の停止制御を検証します。サービス層のテストでは、契約インターフェースをモック化してビジネスロジックを検証します。infra 層のテストでは、通信スタブや一時ディレクトリを活用して、SDK、Git、ファイル境界との結合を検証します。結合テストではこれらのレイヤーを統合し、リリース準備 PR の作成から公開に至る一連のフローを確認します。

## 配布

tsdown を用いて実行時依存ライブラリを単一の `dist/index.mjs` にバンドルし、`action.yml` はこのファイルを直接実行します。ソースコード内のローカルモジュールの import では拡張子を省略し、TypeScript は `moduleResolution: bundler` で解決します。

本リポジトリ自身の `.github/workflows/release.yml` では、`uses: ./` を用いて自身のアクションを実行しています。prepare ジョブでは `.github/easy-release.json` の設定に従ってバージョン更新と `pnpm format` を実行し、準備 PR のマージ後はリリース入力を省略した publish ジョブでリリースを公開します。

## CI

`.github/actions/setup` は、mise-action による各種ツールの自動セットアップと、pnpm による依存パッケージのインストールを行う composite Action です。`ci` ワークフローでは format・lint・type-check・test・diff-check の 5 つのジョブを並列で実行します。diff-check ジョブでは、ビルドによる `dist` ディレクトリのコミット漏れを検出します。

status-check ジョブは上記 5 ジョブを `needs` に指定し、`always()` 条件を用いて実行結果を集約します。すべてのジョブが `success` である場合に限り成功と判定します。
