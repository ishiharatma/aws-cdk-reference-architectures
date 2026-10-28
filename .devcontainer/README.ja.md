# Development Container - Infrastructure Setup

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## 概要 (Overview)

このdev containerは、CDKインフラ構築・管理に必要なツールを全て含んでいます。

## 前提条件 (Prerequisites)

- Docker または WSL上のDockerデーモン
- Visual Studio Code + Dev Containers拡張機能
- プロジェクトのルートディレクトリ直下に、`.aws/config`ファイルが配置されていること

## セットアップ (Setup)

このリポジトリを、プロジェクトのルートディレクトリで `.devcontainer` という名前で clone します。`.aws/` ディレクトリは、同じくプロジェクトのルートに `.devcontainer` と並べて配置します:

```text
your-project/
├── .aws/
│   └── config          # .devcontainer/config.sample からコピー
├── .devcontainer/      # このリポジトリ
└── ...
```

```bash
cd your-project
git clone https://github.com/ishiharatma/devcontainer-aws-cdk-typescript.git .devcontainer
mkdir -p .aws
cp .devcontainer/config.sample .aws/config
```

`.aws/config` を開き、SSO の start URL、アカウント、ロールを環境に合わせて編集してください。

### 構成の選択 (Choose a Configuration)

| 構成 | 利用する場面 |
| ---- | ------------ |
| `.devcontainer/nonProxy/devcontainer.json` | インターネットへ直接接続できる環境 |
| `.devcontainer/withProxy/devcontainer.json` | 社内プロキシ経由で接続する環境 |

`withProxy` を使う場合は、`.devcontainer/withProxy/YourRootCA.cer` を所属組織のルート CA 証明書に置き換えてください。

VS Code でプロジェクトを開き、**Dev Containers: Reopen in Container** を実行します。VS Code が構成を選択するよう求めた場合は、上の表から選んでください。

> `.devcontainer/` は独自の `.git` ディレクトリを持つため、プロジェクトからはネストされたリポジトリとして扱われます。プロジェクトの `.gitignore` に `.devcontainer/` を追加するか、サブモジュールとして管理するかは運用方針に合わせて決めてください。

## 含まれるツール (Included Tools)

- **Node.js & NPM**: JavaScript/TypeScript実行環境
- **TypeScript**: TypeScriptコンパイラ (`tsc`)
- **ESLint**: コード品質チェックツール
- **Git**: ソースコード管理
- **AWS CLI**: AWSリソース管理用コマンドラインツール
- **AWS Session Manager Plugin**: EC2インスタンスへの安全な接続
- **AWS CDK**: Infrastructure as Codeフレームワーク
- **CDKD**: CDKデプロイ用CLI (`cdkd`)
- **cdklocal (aws-cdk-local)**: LocalStack向けCDKラッパー
- **delstack**: CloudFormationスタックの削除ツール
- **Docker CLI**: コンテナ管理・実行
- **UV & UVX**: 高速パッケージマネージャー
- **Python 3 & Graphviz**: Python実行環境と図生成用の `dot`
- **Amazon Q CLI & Kiro CLI**: AIコーディング支援ツール
- **Claude Code**: Claude Code CLI。コンテナ作成時に、プロジェクトの `.claude/settings.json` に記載されたプラグインをインストールします

## AWS認証・アクセス (AWS Authentication)

### 便利なエイリアス

コンテナには以下の便利なAWSやNPM関連エイリアスが設定されています：

- `tips`: エイリアス一覧表示
- AWS関連
  - `awslogin`: デフォルトプロファイルでAWS SSOログイン
  - `awsid`: 現在の認証情報確認
  - `awsloginp <プロファイル名>`: 指定プロファイルでログイン
  - `ssologinp <プロファイル名>`: 指定プロファイルでSSOログイン
  - `awsidp <プロファイル名>`: 指定プロファイルの認証情報確認
  - `swrole`: ロールを切り替えて設定を保存
  - `swcre`: ロールを切り替えて認証情報を保存
  - `clearrole`: プロファイルからAssumeしたロールの認証情報を削除
  - `awslogout`: AWSからログアウトし、必要に応じて認証情報を削除
- NPM関連
  - `npmfl`: フォーマットとLint修正を実行
  - `cdksynth`: npm 経由で `cdk synth` を実行

### 使用例

```bash
# デフォルトプロファイルでログイン
awslogin

# 開発環境管理者としてログイン
awsloginp dev-admin

# 現在の認証情報を確認
awsid

# 本番環境の認証情報を確認
awsidp prd-admin
```

## 注意事項 (Important Notes)

1. **AWS SSO有効期限**: AWS SSOトークンには有効期限があります。期限切れのエラーが表示された場合は `awslogin` または `awsloginp <プロファイル名>` を実行して更新してください。

2. **シークレット管理**: AWSの認証情報やシークレットはGitリポジトリにコミットしないでください。

3. **リソース管理**: デプロイしたAWSリソースは使用後に適切に削除し、不要なコストが発生しないようにしてください。

4. **Docker in Docker**: このコンテナ内ではDockerデーモンが稼働しており、ホストのDockerではなくコンテナ内のDockerを使用します。ボリュームやネットワークはホストとは分離されています。

5. **事前インストール済みツール**: このコンテナには以下のツールが事前にPATHに追加され利用可能です:
   - Node.js & npm: JavaScriptアプリケーション開発用
   - TypeScript & tsc: TypeScript開発用
   - ESLint: コード品質管理用
   - Git: ソースコード版管理用（最新版がソースからビルドされています）
   - AWS CLI & 関連ツール: AWS開発用
   - Docker CLI: コンテナ管理用
   - Python 3 & Graphviz: スクリプト作成と図生成用
   - Claude Code: AI支援開発用

## トラブルシューティング (Troubleshooting)

### AWS認証エラー

AWS SSOログインエラーが発生した場合：

```text
Error when retrieving token from sso: Token has expired and refresh failed
```

対処法: `awslogin` または `awsloginp <プロファイル名>` を実行してトークンを更新してください。

### Dockerコマンドの利用

コンテナ内のDockerを使用する際の注意点:

- ホストマシンのDockerとは独立しています
- イメージやコンテナはホストと共有されません
- 通常通り `docker` コマンドを使用できますが、実行環境はコンテナ内です

### バージョン確認

環境に含まれるツールのバージョンは以下のコマンドで確認できます：

```bash
node -v
npm -v
tsc --version
eslint --version
git --version
aws --version
session-manager-plugin --version
cdk --version
cdkd --version
docker --version
uv --version
uvx --version
python3 --version
dot -V
claude --version
```
