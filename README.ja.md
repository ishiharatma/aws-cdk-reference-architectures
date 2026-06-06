# AWS CDKによるリファレンスアーキテクチャ集

![cover](/cover.png)

AWS CDKで実装されたリファレンスアーキテクチャ集 - AWS CDKを使用した実践的な例を含むクラウドアーキテクチャパターンとベストプラクティスのコレクションリポジトリです。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## 概要

このリポジトリは、AWS CDK（Cloud Development Kit）を使用して実装されたAWSのリファレンスアーキテクチャを提供します。各アーキテクチャパターンには、詳細なドキュメント、アーキテクチャ図、およびTypeScript/PythonによるCDK実装が含まれています。

## はじめに

### 前提条件

- Node.js 20.x以降
- 適切な認証情報が設定されたAWS CLI
- AWS CDK CLI（`npm install -g aws-cdk`でインストール）

このリファレンスアーキテクチャでは、CDKコマンド実行時に渡す`project`と`env`でプロファイル`project-env`を作成しておく必要があります。

#### AWS設定例

**AWS IAM Identity Centerを利用している場合:**

```sh
# ~/.aws/config
[sso-session my-session]
sso_start_url = https://d-98765f432.awsapps.com/start/
sso_region = ap-northeast-1
sso_registration_scopes = sso:account:access

[profile project-env]
sso_session = my-session
sso_account_id = 123456789012
sso_role_name = YourRoleName
region = ap-northeast-1
output = json
```

**IAMユーザーでMFAを利用している場合（ロール想定）:**

```sh
# ~/.aws/config
[profile project-env]
source_profile = project-env-accesskey
role_arn = arn:aws:iam::123456789012:role/YourRoleName
mfa_serial = arn:aws:iam::123456789012:mfa/yourdevicename
region = ap-northeast-1
output = json
```

```sh
# ~/.aws/credentials
[project-env-accesskey]
aws_access_key_id = xxxxxxxxxx
aws_secret_access_key = xxxxxxxxxx
```

**IAMユーザーでMFAを利用している場合（直接権限付与）:**

```sh
# ~/.aws/config
[profile project-env]
source_profile = project-env-accesskey
mfa_serial = arn:aws:iam::123456789012:mfa/yourdevicename
region = ap-northeast-1
output = json
```

```sh
# ~/.aws/credentials
[project-env-accesskey]
aws_access_key_id = xxxxxxxxxx
aws_secret_access_key = xxxxxxxxxx
```

**一時的な認証情報を利用する場合:**

```sh
# ~/.aws/config
[profile project-env]
aws_access_key_id = xxxxxxxxxx
aws_secret_access_key = xxxxxxxxxx
aws_session_token = xxxxxxxxxx
```

### インストール

1. リポジトリのクローン

```bash
git clone https://github.com/ishiharatma/aws-cdk-reference-architectures.git
```

2. 依存関係のインストール

```bash
cd aws-cdk-reference-architectures/infrastructure/cdk
npm install
```

## リポジトリ構成

```text
aws-cdk-reference-architectures/
├── docs/                                    # ドキュメント用のルートフォルダ
├── scripts/                                 # Workspace Initialize Scripts
├── templates/                               # Workspace templates
├── infrastructure/
│   └─── cdk/                                # CDK project root folder
│       ├── common                           # Common
│       └── workspaces                       # CDKワークスペース 
│           └──<pattern-name>
│               ├── bin/                     # CDKアプリケーションのエントリーポイント
│               ├── lib/                     # 
│               |   ├── aspects/             # CDK Aspectsを格納
│               |   ├── constructs/          # CDKのコンストラクトを格納
│               |   ├── stacks/              # CDKのスタックを格納
│               |   ├── stages/              # CDKのステージを格納
│               |   └── types/               # 型定義を格納
│               ├── src/                     # 各種ソースファイルを格納
│               ├── parameters/              # 環境別パラメータ定義を格納
│               └── test/                    # テスト
│                   ├── helpers/             # テスト用のヘルパー関数を格納
│                   ├── snapshot/            # スナップショットテスト
│                   ├── unit/                # Fine-grained assertions テスト
│                   ├── validation/          # バリデーション テスト
│                   ├── integration/         # 統合テスト
│                   └── compliance/          # コンプライアンステスト
│
```

## 利用可能なアーキテクチャパターン

各アーキテクチャパターンには以下が含まれます。

1. アーキテクチャの詳細な説明ドキュメント
2. アーキテクチャ図（draw.ioファイルと画像）
3. デプロイ手順付きのCDK実装
4. コストの考慮事項と運用ガイドライン

## 開発

### CDKワークスペースの使用開始方法

[npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces)を使ったワークスペース構成を使用します。

シェルを利用して初期化します。

```sh
./scripts/init-cdk.sh infrastructure/cdk-workspaces
```

### 実行方法

1. 全ワークスペースの依存関係をインストール

```bash
cd infrastructure/cdk-workspaces
npm install
```

1. 全CDKアプリのビルド

```bash
npm run build
```

1. 特定のCDKアプリのデプロイ

```bash
npm run deploy -w workspaces/serverless --project=example --env=dev
```

### CDKアプリの開発

各CDKアプリは以下の構造に従っています：

```text
workspaces/<pattern-name>/
├── bin/                         # CDKアプリケーションのエントリーポイント
|   └── <pattern-name>.ts        #
├── lib/                         # 
|   ├── aspects/                 # CDK Aspectsを格納
|   ├── constructs/              # CDKのコンストラクトを格納
|   ├── stacks/                  # CDKのスタックを格納
|   |   └── <pattern-name>-stack.ts
|   ├── stages/                  # CDKのステージを格納
|   |   └── <pattern-name>-stage.ts
|   └── types/                   # 型定義を格納
├── src/                         # 各種ソースファイルを格納
├── parameters/                  # 環境別パラメータ定義を格納
├── test/                        # テスト
├── cdk.json                     # CDK設定
└── package.json                 # 依存関係
```

### 新しいCDKアプリの追加

新しいワークスペースを追加する場合は、以下のコマンドを実行します。

```bash
./scripts/add-usecase.sh s3-basics
```

## コントリビューション

コントリビューションを歓迎します！詳細は[コントリビューションガイド](docs/contribution/CONTRIBUTING.md)をご覧ください。

## ライセンス

このプロジェクトはApache License, Version 2.0の下でライセンスされています - 詳細は[LICENSE](LICENSE)ファイルをご覧ください。

## サポート＆フィードバック

ご質問、フィードバック、機能リクエストがありましたら、Issueを作成してください。
