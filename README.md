# easy-release

Changesets や release-please よりも、さらに手軽にリリースを自動化できる GitHub Action です。

リリース時に `major` / `minor` / `patch` を選択し、自動作成された PR をマージするだけ。バージョンの更新からリリースノートの生成、GitHub Release の公開までをすべて自動化します。日々の開発で専用のチェンジセットファイルを作成したり、コミットメッセージの形式（Conventional Commits など）を統一したりする必要はありません。

モノレポ構成などの複数パッケージも、同一バージョンとしてまとめて更新できます。ビルド成果物（アセット）の添付や Docker イメージのビルド処理なども、リリースのワークフローに柔軟に組み込めます。

## 使い方

1. `.github/easy-release.json` を作成し、更新対象のファイルを指定します。
2. 以下のワークフローを `.github/workflows/release.yml` に配置し、必要に応じてビルド処理を調整します。
3. GitHub Actions の画面からワークフローを手動実行（workflow_dispatch）し、デフォルトブランチと更新種別（`major` / `minor` / `patch`）を選択して実行します。作成されたリリース準備 PR を確認してマージします。

### 更新対象の設定

```json
{
  "packageFiles": ["package.json"],
  "updateCommand": "npm ci && npm run format"
}
```

| 設定                | 既定値             | 内容                                                                                   |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `packageFiles`      | 必須               | 更新対象となる `package.json` のパス配列。`packages/*/package.json` などの glob に対応 |
| `tagPrefix`         | `v`                | リリースタグの接頭辞                                                                   |
| `updateVersionTags` | `false`            | 公開成功後にメジャー・マイナータグ（例: `v1`, `v1.2`）を両方自動更新するかどうか       |
| `branchPrefix`      | `release/prepare-` | リリース準備 PR 用ブランチの接頭辞                                                     |
| `updateCommand`     | なし               | バージョン更新後に実行する Bash コマンド                                               |

現在のバージョンは、既存の Git タグの中から最新の安定版セマンティックバージョンを取得して決定します。該当するタグが存在しない場合は `0.0.0` を基準とします。対象のパッケージはすべて同じバージョンに揃えて更新されます。

上記の例では、`updateCommand` で依存関係をインストールし、`package.json` の `format` スクリプトを実行してフォーマットを整えています。その他の関連ファイルの更新処理もこのコマンドに含めることができます。コマンド実行時には環境変数 `PREVIOUS_VERSION`（更新前バージョン）と `RELEASE_VERSION`（更新後バージョン）が渡されます。必要なツールやランタイムは、Action の実行前にセットアップしてください。

### 基本のワークフロー

`prepare` ジョブでリリース準備 PR を作成し、PR マージ後に `draft` → `assets` → `publish` の順でジョブを実行します。以下の例では Node.js 24 と npm を使用しています。リポジトリに `package-lock.json` と、`package.json` の `format`・`build` スクリプトを用意してください。なお、GitHub のリポジトリ設定（Settings > Actions > General > Workflow permissions）で「Allow GitHub Actions to create and approve pull requests」を有効にしておく必要があります。

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      release_type:
        description: Version bump
        required: true
        type: choice
        options: [patch, minor, major]
  pull_request:
    types: [closed]

permissions:
  contents: write

concurrency:
  group: easy-release
  cancel-in-progress: false

jobs:
  prepare:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.sha }}
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - uses: shun-shobon/easy-release@v0.1.0
        with:
          mode: prepare
          release-type: ${{ inputs.release_type }}

  draft:
    if: github.event_name == 'pull_request' && github.event.pull_request.merged
    runs-on: ubuntu-latest
    outputs:
      ready: ${{ steps.draft.outputs.ready }}
      tag: ${{ steps.draft.outputs.tag }}
      commit: ${{ steps.draft.outputs.commit }}
      release-id: ${{ steps.draft.outputs.release-id }}
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.merge_commit_sha }}
      - uses: shun-shobon/easy-release@v0.1.0
        id: draft
        with:
          mode: draft

  assets:
    needs: draft
    if: needs.draft.outputs.ready == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ needs.draft.outputs.commit }}
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - name: Build and upload assets
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          RELEASE_TAG: ${{ needs.draft.outputs.tag }}
        run: |
          npm ci
          npm run build
          tar -czf app.tar.gz -C dist .
          gh release upload "$RELEASE_TAG" app.tar.gz --clobber

  publish:
    needs: [draft, assets]
    if: needs.draft.outputs.ready == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ needs.draft.outputs.commit }}
      - uses: shun-shobon/easy-release@v0.1.0
        with:
          mode: publish
          release-id: ${{ needs.draft.outputs.release-id }}
          tag: ${{ needs.draft.outputs.tag }}
          commit: ${{ needs.draft.outputs.commit }}
```

[このワークフロー設定例をコピー](examples/release.yml)してそのまま利用できます。`assets` ジョブのビルドコマンドや成果物のパスは、プロジェクトの構成に合わせて変更してください。Docker イメージのビルドなどを別ジョブとして切り出す場合は、`publish` ジョブの `needs` にそのジョブを追加してください。

### draft を省略するワークフロー

リリースへのアセット添付が不要な場合は、準備 PR のマージ後に `publish` ジョブのみを実行するシンプルな構成にできます。基本ワークフローの `prepare` ジョブはそのまま利用し、`draft`・`assets`・`publish` の 3 ジョブを以下の 1 ジョブに置き換えます。[ワークフロー全体の例はこちら](examples/release-without-draft.yml)に用意されています。

```yaml
publish:
  if: github.event_name == 'pull_request' && github.event.pull_request.merged
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v7
      with:
        ref: ${{ github.event.pull_request.merge_commit_sha }}
    - uses: shun-shobon/easy-release@v0.1.0
      with:
        mode: publish
```

`release-id`・`tag`・`commit` はすべて省略します。マージされた準備 PR と対象パッケージのバージョンを検証したうえで、タグおよび GitHub Release を作成・公開します。内部的にはドラフトリリースを作成してから公開するため、同じタグ・コミットに対応する既存のドラフトがあれば再利用されます。必要なビルドやテストなどの検証は、publish を実行する前のステップで完了させてください。リリースへのアセット添付が必要な場合は、基本ワークフローを使用してください。

### メジャー・マイナータグの更新

設定ファイル `.github/easy-release.json` に `"updateVersionTags": true` を指定すると、リリースの公開成功後にメジャーおよびマイナーのタグ（Floating Tags）を自動で更新します。たとえば `v1.2.3` を公開した場合、`v1` および `v1.2` タグが今回のリリースと同じコミットを指すように移動され、タグが存在しない場合は新規作成されます（既定では無効）。

```json
{
  "packageFiles": ["package.json"],
  "updateVersionTags": true
}
```

タグの接頭辞には、設定ファイル内の `tagPrefix` が適用されます。たとえば `tagPrefix` が `app/v` の場合は `app/v1` と `app/v1.2`、空文字 `""` の場合は `1` と `1.2` が更新されます。設定ファイルの配置パスを変更した場合は、すべてのモードで同一の `config` 入力を指定してください。

タグの移動先は、今回公開したリリースのコミットです。過去のバージョンを意図的に公開した場合もそのコミットへ移動します。タグ更新の途中でエラーが発生した場合でも、すでに公開されたリリースや更新済みのタグはロールバックされずそのまま残ります。公開済みリリースに対して publish を再実行することはできないため、未完了のタグ更新は手動で行ってください。

## 入力

| 名前           | 使用モード | 内容                                                     |
| -------------- | ---------- | -------------------------------------------------------- |
| `mode`         | 共通       | 必須。`prepare` / `draft` / `publish`                    |
| `token`        | 共通       | GitHub トークン。既定値は `${{ github.token }}`          |
| `config`       | 共通       | 設定ファイルのパス。既定値は `.github/easy-release.json` |
| `release-type` | prepare    | 必須。`major` / `minor` / `patch`                        |
| `release-id`   | publish    | 既存ドラフトの公開時に指定する `release-id`              |
| `tag`          | publish    | 既存ドラフトの公開時に指定する `tag`                     |
| `commit`       | publish    | 既存ドラフトの公開時に指定する `commit`                  |

`release-id`・`tag`・`commit` は、3 つすべてを同時に指定するか、3 つすべてを省略する必要があります。一部のみを指定した場合はエラーとなります。省略時は、準備 PR に対する `pull_request: closed` イベントの発火と、そのマージコミットの checkout が必須となります。

GitHub トークンには `contents: write` 権限が必要です。また、`prepare` モードではプルリクエストを作成するため、追加で `pull-requests: write` 権限が必要です。

## 出力

出力値は、ステップの `id` を用いて `steps.<id>.outputs.<名前>` の形式で参照します。別ジョブへ渡す場合は、基本ワークフローの例のようにジョブの `outputs` にマッピングし、後続ジョブから `needs.<job>.outputs.<名前>` で受け取ります。

| 名前                  | 使用モード                             | 内容                                                           |
| --------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `version`             | prepare / draft / 入力省略時の publish | 更新後のバージョン                                             |
| `tag`                 | 共通                                   | リリースタグ                                                   |
| `commit`              | 共通                                   | prepare は準備コミット、draft / publish はリリース対象コミット |
| `pull-request-number` | prepare                                | 準備 PR の番号                                                 |
| `pull-request-url`    | prepare                                | 準備 PR の URL                                                 |
| `ready`               | draft / 入力省略時の publish           | リリース対象の PR なら `true`、対象外の PR なら `false`        |
| `release-id`          | draft / publish                        | GitHub Release の ID                                           |
| `release-url`         | draft / publish                        | GitHub Release の URL                                          |

`ready` は文字列 `'true'` と比較して判定します。`false` の場合、他の出力値は設定されません。draft を利用する構成では、アセットのビルド対象として draft モードの `commit` 出力を使用し、公開時には draft モードの `release-id`・`tag`・`commit` をそのまま publish モードへ渡してください。
