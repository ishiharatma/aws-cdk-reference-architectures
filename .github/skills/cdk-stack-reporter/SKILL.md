name: cdk-stack-reporter
description: 全環境（dev / stage / prod）の CDK スタック状況をレポートするスキル。ユーザーが「<プロジェクト名>のスタック取得」「<プロジェクト名>のスタック状況教えて」「スタック一覧を確認したい」などと言ったときに使用する。プロジェクト名が指定されていない場合はユーザーに確認する。

# ⚠️ 実行時間について
このスキルの実行は、環境やスタック数によっては **200秒以上かかる場合があります**。処理中は待機してください。

# CDK スタック状況レポーター

全環境（dev / stage / prod）のデプロイ済みスタック状況を取得してレポートするスキル。

## 事前準備

以下が必要：

- `aws` CLI（v2）がインストールされていること
- 各環境のプロファイル（`<project>-dev`、`<project>-stage`、`<project>-prod`）が設定されていること
- `infra/` ディレクトリで `npm install` 済みであること

## 実行方法

リポジトリルートから実行する。

```bash
# 基本（全環境）
python3 .github/skills/cdk-stack-reporter/report.py --project <project_name>

# 例: プロジェクト名が example の場合
python3 .github/skills/cdk-stack-reporter/report.py --project example

# 特定環境のみ
python3 .github/skills/cdk-stack-reporter/report.py --project example --envs dev stage

# リージョン指定（デフォルト: ap-northeast-1）
python3 .github/skills/cdk-stack-reporter/report.py --project example --region us-east-1

# infra ディレクトリが別の場所にある場合
python3 .github/skills/cdk-stack-reporter/report.py --project example --infra-dir ./path/to/infra
```

## レポート内容

環境ごとに以下のテーブルを出力する。

| カラム | 内容 |
|---|---|
| スタック名 | CDK list で取得したスタック名 |
| ステータス | CloudFormation スタックステータス（例: `UPDATE_COMPLETE`） |
| 作成日時 (JST) | スタック作成日時（JST 変換済み） |
| 最終更新日時 (JST) | 最後に更新された日時（JST 変換済み） |
| 削除保護 | 有効: 🔏 / 無効: `-` |

### ステータス凡例（代表的なもの）

| ステータス | 意味 |
|---|---|
| `CREATE_COMPLETE` | 作成完了 |
| `UPDATE_COMPLETE` | 更新完了 |
| `ROLLBACK_COMPLETE` | ロールバック完了（要確認） |
| `DELETE_FAILED` | 削除失敗（要確認） |
| `❓ 未デプロイ or 取得失敗` | まだデプロイされていないか、AWS 接続エラー |

## AI エージェントの動作手順

1. ユーザーが「<プロジェクト名>のスタック取得 / 状況」などと言ったら本スキルを発動する
2. プロジェクト名が不明な場合はユーザーに確認する
3. スクリプトを実行してレポートを取得する
4. 出力されたテーブルをそのままユーザーに提示する
5. ステータスに `ROLLBACK` / `FAILED` が含まれる場合は注意喚起する

## エラーが出た場合

| エラー内容 | 対処 |
|---|---|
| `infra ディレクトリが見つかりません` | `--infra-dir` オプションで正しいパスを指定する |
| `スタック一覧の取得に失敗しました` | AWS CLI プロファイルの認証情報を確認する（`aws sso login --profile <project>-<env>` 等） |
| `❓ 未デプロイ or 取得失敗` | そのスタックがまだデプロイされていないか、スタック名が変わっている可能性がある |
