# easy-release

Changesets や release-please よりも、もっと手軽なリリースを目指す GitHub Action です。

リリースするときに `major` / `minor` / `patch` を選び、作成された PR をマージするだけ。バージョン更新からリリースノートの生成、GitHub Release の公開まで自動化します。日々の開発で専用の変更ファイルを追加したり、コミット形式を揃えたりする必要はありません。

複数パッケージも同じバージョンにまとめて更新できます。アセットや Docker イメージのビルドも、リリースの流れに組み込めます。

## 使い方

1. `.github/easy-release.json` に更新対象を指定します。
2. 以下のワークフローを `.github/workflows/release.yml` に保存し、ビルド処理を調整します。
3. Actions 画面でデフォルトブランチと更新種別を選んで実行し、作成された PR をマージします。

### 更新対象の設定

```json
{
  "packageFiles": ["package.json"],
  "updateCommand": "npm ci && npm run format"
}
```

| 設定            | 既定値             | 内容                                                                         |
| --------------- | ------------------ | ---------------------------------------------------------------------------- |
| `packageFiles`  | 必須               | 更新する `package.json` の配列。`packages/*/package.json` などの glob に対応 |
| `tagPrefix`     | `v`                | リリースタグの接頭辞                                                         |
| `branchPrefix`  | `release/prepare-` | 準備 PR のブランチ接頭辞                                                     |
| `updateCommand` | なし               | バージョン更新後に実行する Bash コマンド                                     |

現在のバージョンは Git タグの最大の安定版から取得し、タグがなければ `0.0.0` を基準にします。対象パッケージはすべて同じ版に更新します。

例では `updateCommand` で依存関係をインストールし、`package.json` の `format` スクリプトを実行します。その他のファイルの更新もこのコマンドに追加できます。コマンドには環境変数 `PREVIOUS_VERSION` と `RELEASE_VERSION` が渡されます。必要なツールは prepare の Action 実行前にセットアップしてください。

### ワークフロー

`prepare` で更新 PR を作り、マージ後に `draft` → `assets` → `publish` の順に実行します。例では Node.js 24 と npm を使います。`package-lock.json` と、`package.json` の `format`・`build` スクリプトを用意してください。GitHub の Actions 設定で PR 作成を許可する必要があります。

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
      - uses: shun-shobon/easy-release@v0.1.0
        with:
          mode: publish
          release-id: ${{ needs.draft.outputs.release-id }}
          tag: ${{ needs.draft.outputs.tag }}
          commit: ${{ needs.draft.outputs.commit }}
```

[この例をコピー](examples/release.yml)して使えます。`assets` のビルドコマンドと成果物のパスはプロジェクトに合わせて変更してください。Docker ビルドなどを別ジョブにする場合は、`publish.needs` にそのジョブを追加します。

## 入力

| 名前           | 使用モード      | 内容                                                     |
| -------------- | --------------- | -------------------------------------------------------- |
| `mode`         | 共通            | 必須。`prepare` / `draft` / `publish`                    |
| `token`        | 共通            | GitHub トークン。既定値は `${{ github.token }}`          |
| `config`       | prepare / draft | 設定ファイルのパス。既定値は `.github/easy-release.json` |
| `release-type` | prepare         | 必須。`major` / `minor` / `patch`                        |
| `release-id`   | publish         | 必須。draft が出力した `release-id`                      |
| `tag`          | publish         | 必須。draft が出力した `tag`                             |
| `commit`       | publish         | 必須。draft が出力した `commit`                          |

トークンには `contents: write`、prepare では加えて `pull-requests: write` が必要です。

## 出力

ステップの `id` を使って `steps.<id>.outputs.<名前>` で参照します。別ジョブに渡す場合は、上の例のようにジョブの `outputs` に指定し、`needs.<job>.outputs.<名前>` で受け取ります。

| 名前                  | 使用モード      | 内容                                                           |
| --------------------- | --------------- | -------------------------------------------------------------- |
| `version`             | prepare / draft | 更新後のバージョン                                             |
| `tag`                 | 共通            | リリースタグ                                                   |
| `commit`              | 共通            | prepare は準備コミット、draft / publish はリリース対象コミット |
| `pull-request-number` | prepare         | 準備 PR の番号                                                 |
| `pull-request-url`    | prepare         | 準備 PR の URL                                                 |
| `ready`               | draft           | リリース対象なら `true`、対象外の PR なら `false`              |
| `release-id`          | draft / publish | GitHub Release の ID                                           |
| `release-url`         | draft / publish | GitHub Release の URL                                          |

`ready` は文字列 `'true'` と比較します。`false` の場合、他の出力は設定されません。ビルドには draft の `commit` を使い、公開には draft の `release-id`・`tag`・`commit` を渡してください。
