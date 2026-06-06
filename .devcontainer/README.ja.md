# Development Container - Infrastructure Setup

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## 概要 (Overview)

このdev containerは、CDKインフラ構築・管理に必要なツールを全て含んでいます。

## 前提条件 (Prerequisites)

- Docker または WSL上のDockerデーモン
- Visual Studio Code + Dev Containers拡張機能
- プロジェクトのルートディレクトリ直下に、`.aws/config`ファイルが配置されていること

## 含まれるツール (Included Tools)

- **Node.js & NPM**: JavaScript/TypeScript実行環境
- **TypeScript**: TypeScriptコンパイラ (`tsc`)
- **ESLint**: コード品質チェックツール
- **Git**: ソースコード管理
- **AWS CLI**: AWSリソース管理用コマンドラインツール
- **AWS Session Manager Plugin**: EC2インスタンスへの安全な接続
- **AWS CDK**: Infrastructure as Codeフレームワーク
- **Docker CLI**: コンテナ管理・実行
- **UV & UVX**: 高速パッケージマネージャー

## AWS認証・アクセス (AWS Authentication)

### 便利なエイリアス

コンテナには以下の便利なAWSやNPM関連エイリアスが設定されています：

- `tips`: エイリアス一覧表示
- AWS関連
  - `awslogin`: デフォルトプロファイルでAWS SSOログイン
  - `awsid`: 現在の認証情報確認
  - `awsloginp <プロファイル名>`: 指定プロファイルでログイン
  - `awsidp <プロファイル名>`: 指定プロファイルの認証情報確認
- NPM関連
  - `npmfl`: フォーマットとLint修正を実行

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
docker --version
uv --version
uvx --version
```
