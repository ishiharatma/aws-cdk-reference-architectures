# デモ: Agentic Review ゲートを実際に動かしてみる

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

`AgenticReview` パイプラインステージを、実際に引っかかるはずの diff で
end-to-end に動作確認するための仕組み。`src/index.js` に危険なコードを
恒久的に混入させることなく検証できるよう、`inject-risky-change.js` が
`risky-snippet.js`（各観点に対応するよう作られた5つのエンドポイント）を
挿入・削除する。

| 観点 | スニペットの内容 |
| --- | --- |
| セキュリティ | AWS の認証情報と DB パスワードのハードコード。認証・認可なしでユーザー入力をそのままシェルコマンド（`exec`）に渡すエンドポイント。ユーザー入力を文字列連結した「SQL」を組み立て、パスワードごとログ出力する2つ目のエンドポイント |
| インフラ/運用 | 空の `catch` ブロックを持つエンドポイント — エラーを握りつぶし、ログにも残らない |
| コスト | 1リクエストあたり同期的に5,000回の外部HTTP呼び出しを1件ずつ発行するエンドポイント |
| コード品質 | 深くネストした重複条件分岐と、到達不能な分岐 |

**絶対にデプロイしないこと。** これは `AgenticReview` に読ませる
`git diff` を作るためのものであり、実行するためのものではない。この
サンプルには対応する ECS クラスタの実体がない（メインの README 参照）
ため、いずれにせよデプロイは発生しないが、このデモの目的以外では
`main`/`develop` ブランチに含めないこと。

## 手順

`backend/ecspresso-bedrock-review-app/` から、使い捨てのブランチ上で
（または直後に revert する前提で — 下記参照）実行する:

```bash
# 1. 危険な変更を適用する
node demo/inject-risky-change.js apply

# 2. 生成された diff を確認する
git diff -- src/index.js

# 3. アプリが起動すること、変更していないエンドポイントのテストが通ることを確認する
npm test

# 4. パイプラインが監視しているブランチへ commit・push する（EnvParams.branchName を参照、既定は "develop"）
git add src/index.js
git commit -m "demo: intentionally risky change for agentic review testing"
git push origin develop
```

## 期待される結果

- `AgenticReview` の CodeBuild プロジェクトが diff をレビューし、少なくとも
  セキュリティ観点では `HIGH` または `CRITICAL` を返すはず（ハードコード
  された認証情報とコマンドインジェクションは明白な問題のため）。パイプ
  ライン全体がブロックされるかどうかは `RISK_THRESHOLD`（既定 `high`）と
  そのモデルの判断次第 — Bedrock によるレビューは決定的ではないため、
  「ほぼ確実に引っかかるはず」であって、毎回必ず引っかかることを保証
  するものではない点に注意。
- 実際のレビューと同じ3箇所（＋1）で結果を確認できる（詳細はワークスペース
  のメイン README の「レビュー結果はどこで確認できるか」「レビューの
  効果を経時的に測定する」節を参照）:
  - `AgenticReview` CodeBuild プロジェクトのログ
  - `AgenticReviewOutput` パイプラインアーティファクト
  - `reviewNotificationEnabled: true` の場合は SNS 通知
  - `AgenticReviewDashboard` CloudWatch ダッシュボード（今回の実行の
    リスクレベル・ブロック率もここに反映される）

## 後片付け

```bash
node demo/inject-risky-change.js revert
git add src/index.js
git commit -m "revert: remove agentic review demo change"
git push origin develop
```

`revert` は冪等 — 何も適用されていない状態で実行しても
"nothing to revert" と表示して正常終了するだけ。`apply` は既に適用済みの
状態に対しては二重に実行できない（先に `revert` を実行する必要がある）
ため、スニペットが重複挿入されることはない。
