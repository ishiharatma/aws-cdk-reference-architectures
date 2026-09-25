# Cognito + API Gateway 認証・認可 - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Level: 300 (Intermediate)**

**Amazon Cognito** で REST API を保護する方法です。人(と機械)を認証する user pool、トークンと OAuth **スコープ**を検証する API Gateway の **Cognito オーソライザー**、そして Lambda にしかできない **グループ所属**と**ユーザーごとのデータ所有権**の強制で構成します。ALB の背後でセルフホストする [`alb-keycloak-auth`](../alb-keycloak-auth/)(Keycloak)に対する、マネージドサービス版です。

| エンドポイント | 呼び出せる主体 | トークン | 強制する場所 |
|---|---|---|---|
| `GET /me` | サインイン済みの任意のユーザー | **ID トークン** | オーソライザー |
| `GET /notes` | スコープ `notes/read`(ユーザー、マシン) | **アクセストークン** | オーソライザー(スコープ) |
| `POST /notes` | スコープ `notes/write`(ユーザー) | **アクセストークン** | オーソライザー(スコープ) |
| `GET /admin` | グループ `admin` | **ID トークン** | Lambda(`cognito:groups` クレーム) |

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [Well-Architected との対応](#-well-architected-との対応)
- [コスト最適化](#-コスト最適化)
- [セキュリティ](#-セキュリティ)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [動作確認スクリプト](#-動作確認スクリプト)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Diagram](overview.drawio.svg)

### 主要コンポーネント

- **Cognito user pool** — 管理者作成ユーザーのみ(`selfSignUpEnabled: false`)、メールでサインイン、12 文字以上のパスワード、**任意の TOTP のみの MFA**(SMS なし)、メールのみのリカバリ、dev 以外は削除保護。グループは `admin` と `member`。
- **リソースサーバー `notes`** — スコープ `notes/read` と `notes/write` を定義。
- **Web クライアント**(パブリック、シークレットなし)— ホスト UI に対する認可コード + **PKCE**。SRP は常に有効、`USER_PASSWORD_AUTH` は `enablePasswordAuthFlow` が true(dev)のときのみ。`preventUserExistenceErrors`、トークン失効、アクセス/ID トークン 60 分、リフレッシュトークン 30 日。
- **マシンクライアント**(シークレットあり)— `client_credentials`、`notes/read` のみ。
- **ホストドメイン** — `/login` と `/oauth2/token` を提供。
- **API Gateway(REST)** — `CognitoUserPoolsAuthorizer`、メソッドごとのスコープ、`POST /notes` 用のリクエストバリデータと JSON スキーマモデル、ステージのスロットリング、アクセスログ。
- **Lambda ×3**(Node.js 24 / ARM64)— `me`、`admin`、`notes`。DynamoDB に到達できるのは `notes` のみ(`PutItem`、`Query`)。
- **DynamoDB `notes`** — パーティションキーはトークンの `sub`。呼び出し元は自分のパーティションにしか触れません。

## 🎯 設計判断とベストプラクティス

### 1. 認可は 2 層に分け、それぞれ最も安く強制できる場所で行う

オーソライザーは、不正なトークンやスコープ不足を **Lambda が動く前に**拒否します(実行コストなし)。グループ所属とデータ所有権はアプリの文脈が必要なので関数が強制しますが、それは**オーソライザーが検証済みのクレーム**に対してだけです。関数自身が JWT を解析・検証することはありません。

### 2. ID トークンとアクセストークン — 定番の 401

`authorizationScopes` を**指定しない**とオーソライザーは **ID トークン**を、指定すると **アクセストークン**を期待します(スコープはアクセストークンにしか存在しないため)。種類を間違えると `401 Unauthorized` になります。「このユーザーは誰か」のエンドポイント(`/me`、`/admin`)は ID トークン、リソースのエンドポイント(`/notes`)はアクセストークンを使います。確認スクリプトは 4 通りの組み合わせをすべて検証します。

### 3. カスタムスコープは OAuth フローで発行されたトークンにしか入らない

`InitiateAuth`(`USER_PASSWORD_AUTH` / SRP)で得たアクセストークンには `aws.cognito.signin.user.admin` しか入らず、`notes/read` / `notes/write` は**入りません**。それでスコープ付きメソッドを呼ぶと 401 です。カスタムスコープ付きのユーザートークンは**認可コードフロー**(ホスト UI)で取得する必要があり、確認スクリプトは `curl` でこれを再現します(ログインフォーム + CSRF トークン + PKCE)。`client_credentials` のマシントークンは、付与されたスコープを持ちます。

### 4. スコープ不足は `403` ではなく `401`

有効なアクセストークンでもメソッドのスコープを持たない場合(マシントークンで `POST /notes`)、REST API の Cognito オーソライザーは **401** で拒否します。この API での `403` は「認証済みだが許可されていない」を意味し、Lambda から返ります(管理者以外の `/admin`)。

### 5. グループは関数内で ID トークンから読む

オーソライザーはグループを検査しません。`cognito:groups` は REST API の Lambda プロキシには配列ではなく**平坦化された文字列**(`admin`、または `[admin member]`)で届くため、`groupsOf()` が両方の形を解析します(ユニットテスト済み)。

### 6. データ分離を構造で保証する

`notes` は検証済みクレームから `sub` を読み、すべての読み書きのパーティションキーに使います。改ざんできるユーザー指定の識別子は存在しません(マシントークンでは `sub` がクライアントなので、マシンも自分のパーティションを持ちます)。なお **`sub` は DynamoDB の予約語**で、`KeyConditionExpression: 'sub = :sub'` は `ValidationException` になるため `#sub` でエイリアスしています。ユニットテストでは検出できず、E2E 実行(`/notes` が 502)で発覚しました。

### 7. Web クライアント: パブリック + PKCE + SRP

ブラウザやモバイルアプリはシークレットを保持できないため、Web クライアントにはシークレットがなく、コード + PKCE を使います。`USER_PASSWORD_AUTH` はパスワードを Cognito に直接送るので、スクリプトによるテスト用に `EnvParams.enablePasswordAuthFlow` でのみ有効にしています。本番では無効のままにしてください。

### 8. マシン間通信は別クライアントで

サービスには `client_credentials` と**最小のスコープ**(`notes/read`)を持つ専用クライアントを使います。ユーザー向けクライアントをマシンに流用してはいけません。

### 9. 短命なトークンと失効可能なリフレッシュ

アクセス/ID トークンは 60 分、リフレッシュトークンは 30 日で `enableTokenRevocation` 付きなので、サインアウトでリフレッシュトークンを無効化できます。

### 10. 環境別パラメータ

`parameters/<env>-params.ts` の `enablePasswordAuthFlow`、`callbackUrls`、`logoutUrls`、`apiRateLimit`、`apiBurstLimit`。

## 🏛️ Well-Architected との対応

| 柱 | 実装 |
|---|---|
| **運用上の優秀性** | 関数ごとのロググループ+アクセスログ、`test-auth.sh` が誰を通し誰を止めるかを実証、スナップショット/ユニット/Nag テスト |
| **セキュリティ** | マネージドな ID プロバイダー、コンピュートの前にオーソライザー、スコープ + グループ + 所有権、PKCE、任意の TOTP MFA、強いパスワードポリシー、ユーザー存在の漏えい防止、最小権限 IAM(DynamoDB に到達するのは 1 関数のみ、Put/Query のみ) |
| **信頼性** | マネージド・マルチ AZ、リフレッシュトークンでセッション維持、テーブルは PITR |
| **パフォーマンス効率** | オーソライザーでの拒否により Lambda 起動を回避、ARM64 |
| **コスト最適化** | ゼロスケールのコンピュート、オンデマンド DynamoDB、Cognito はアクティブユーザー課金 |
| **持続可能性** | マネージドサービスで常駐サーバーなし(ECS + Aurora 上の Keycloak と対照的) |

## 💰 コスト最適化

Cognito は**月間アクティブユーザー(MAU)**単位で課金され(無料枠あり)、マシン間のトークンリクエストは別課金です。フィーチャープランとリージョンに応じた単価は [Cognito の料金ページ](https://aws.amazon.com/cognito/pricing/)で確認してください。それ以外はゼロにスケールします。

```
API Gateway REST:   100,000 リクエスト x $4.25 / 100万        ≈ $0.43
Lambda(3 関数):   100,000 呼び出し、256 MB arm64             ≈ $0.10
DynamoDB オンデマンド: 約 50,000 リクエスト                    ≈ $0.05
CloudWatch Logs:    1 GB 未満                                  ≈ $0.50
---------------------------------------------------------------
≈ 月 $1.1(ap-northeast-1、概算、Cognito を除く)
```

Keycloak のセルフホスト([`alb-keycloak-auth`](../alb-keycloak-auth/))と比べると、ALB、Fargate タスク、Aurora、パッチ適用が不要になります。代わりにカスタマイズ性は下がります。

## 🔒 セキュリティ

### 実装済み
- ✅ Lambda の前に API Gateway がトークンを検証し、メソッドごとにスコープを確認
- ✅ グループと所有権のチェックは検証済みクレームのみに対して実施
- ✅ 対話型クライアントは認可コード + PKCE、パブリッククライアントにシークレットなし
- ✅ 管理者作成ユーザー、強いパスワードポリシー、任意の TOTP MFA、`preventUserExistenceErrors`
- ✅ 保存時の暗号化(DynamoDB SSE、PITR)、TLS のみのエンドポイント

### CDK Nag の抑制(理由付き)

| ルール | 理由 |
|---|---|
| `AwsSolutions-COG2` | スクリプトによるサインインのため MFA は `OPTIONAL`。実ユーザーには `REQUIRED` にする |
| `AwsSolutions-COG3` / `COG8` | 脅威保護は Plus フィーチャープラン(MAU 課金)が必要なため対象外 |
| `AwsSolutions-APIG3` | WAFv2 Web ACL は固定の月額費用がかかる。ステージのスロットリングとオーソライザーで濫用を抑える |
| `AwsSolutions-IAM4` | AWS 推奨のログ用マネージドポリシー |

### 対象外(環境ごとに追加)
- MFA の強制、Plus プラン、カスタムドメインとマネージドログインのブランディング、フェデレーション(SAML/OIDC)、WAF、ユーザー層に合わせたアカウントリカバリの規則。
- dev 以外では `enablePasswordAuthFlow: false` にする。

## 📋 前提条件

- CDK の bootstrap 済みの AWS アカウント、`${PROJECT}-${ENV}` という名前のプロファイルを設定した AWS CLI v2、Node.js 20 以上、確認スクリプト用の `jq`・`curl`・`openssl`

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install
export PROJECT=<project> ENV=dev

npm run bootstrap        -w workspaces/cognito-apigw-auth   # 初回のみ
npm run synth            -w workspaces/cognito-apigw-auth
npm run stage:deploy:all -w workspaces/cognito-apigw-auth
```

出力: `ApiUrl`、`UserPoolId`、`WebClientId`、`MachineClientId`、`TokenEndpoint`、`NotesTableName`。ユーザーを作成してグループに追加します。

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username you@example.com --group-name admin
```

## 🧪 動作確認スクリプト

[`test-auth.sh`](./test-auth.sh) は、実際のユーザーをサインインさせ、実際のトークンで実際の API を呼びます。

```bash
./test-auth.sh --project <project> --env dev            # 検証(ユーザー 3 名を作成して削除)
./test-auth.sh --project <project> --env dev --destroy  # 検証後にスタックも削除
```

検証内容(22 項目): トークンなし/不正トークン → 401、`/me` に ID トークン → 200 で正しいメール、**`/me` にアクセストークン → 401**、**`/notes` に ID トークン → 401**、**`InitiateAuth` のアクセストークンで `/notes` → 401**、OAuth フローのアクセストークンは `notes/read` + `notes/write` を持ち `POST`/`GET /notes` が可能、**ユーザー B にはユーザー A のノートが見えない**、不正なボディ → 400、`/admin` はメンバー → 403・管理者 → 200、**マシントークン**は `GET /notes` 200・`POST /notes` 401・`GET /me` 401、リフレッシュトークンから有効なアクセストークンを取得。

## 🧪 テスト戦略

```bash
npm test -w workspaces/cognito-apigw-auth   # 27 テスト
```

| 種類 | 対象 |
|---|---|
| スナップショット(2) | テンプレート + リソース数(Lambda アセットのハッシュは正規化) |
| ユニット(23) | user pool のポリシー/MFA、グループ、リソースサーバー、2 つのクライアント、ドメイン、オーソライザーとメソッドごとのスコープ、バリデータ/モデル、スロットリング、テーブルのキー、IAM アクションの集合、`groupsOf` / `admin` / `me` ハンドラー |
| コンプライアンス(2) | CDK Nag `AwsSolutions` |
| 運用確認 | デプロイ済みスタックに対する `test-auth.sh` |

## ⚙️ カスタマイズ

- **スコープの追加**: `ResourceServerScope` を追加してクライアントに付与し、`authorizationScopes` に `<identifier>/<scope>` を指定します。
- **ソーシャル/エンタープライズログイン**: ID プロバイダー(`UserPoolIdentityProviderGoogle`、`…Oidc`、`…Saml`)を追加し、`supportedIdentityProviders` に含めます。
- **REST の代わりに HTTP API**: `HttpJwtAuthorizer` は JWT をネイティブに検証し(別のオーソライザーリソースが不要)、アクセストークンからスコープを読みます。
- **MFA の強制**: `mfa: cognito.Mfa.REQUIRED`
- **トークン生成前トリガー**: カスタムクレームの追加やグループの上書き。

## 🔧 トラブルシューティング

### 有効に見えるトークンで `401 Unauthorized`
トークンの種類の誤りです。スコープなしのメソッドは **ID トークン**、スコープ付きのメソッドは**アクセストークン**が必要で、そのスコープを含んでいなければなりません(`InitiateAuth` のトークンには含まれません)。トークンをデコード(`cut -d. -f2 | base64 -d`)して `token_use` と `scope` を確認してください。

### `/notes` が `502` を返す
関数が例外を投げています。ログを確認してください。`sub` の `KeyConditionExpression` には `#sub` が必要です(予約語)。

### ホスト UI のサインインが `redirect_mismatch` を返す
`redirect_uri` は `callbackUrls` のいずれかと完全に一致する必要があります。

### `admin` に追加したのに `/admin` が 403 を返す
グループはサインイン時にトークンへ埋め込まれます。再度サインインして新しい ID トークンを取得してください。

### `InitiateAuth` で `USER_PASSWORD_AUTH flow not enabled`
`enablePasswordAuthFlow: true`(dev のみ)にして再デプロイします。

### しばらくすると `cdk deploy` が "no credentials" で失敗する
同梱の CDK は期限切れの SSO トークンを更新できません。短期認証情報をエクスポート(`aws configure export-credentials --format env`)するか、`aws sso login` をやり直してください。

## 🧹 クリーンアップ

```bash
npm run stage:destroy:all -w workspaces/cognito-apigw-auth   # または ./test-auth.sh ... --destroy
```

本番以外では user pool、テーブル、ロググループが削除されます(`RemovalPolicy.DESTROY`、削除保護なし)。

## 📚 参考資料

### AWS ドキュメント
- [Amazon Cognito ユーザープールを使用した REST API へのアクセスの制御](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html)
- [Amazon Cognito のアプリクライアントと OAuth 2.0 スコープ / リソースサーバー](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html)
- [ユーザープールでのトークンの使用](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html)
- [DynamoDB の予約語](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html)

### 関連アーキテクチャ
- [alb-keycloak-auth](../alb-keycloak-auth/) — セルフホストの代替(ALB の背後の ECS + Aurora 上の Keycloak)
- [apigw-single-purpose-lambda](../apigw-single-purpose-lambda/) — 認証なしの同じ API Gateway + DynamoDB 構成
- [dynamodb-vector-search-semantic-api](../dynamodb-vector-search-semantic-api/) — API キーで保護した API

## 📄 ライセンス

このプロジェクトは MIT ライセンスです。詳細は [LICENSE](../../LICENSE) を参照してください。

## 👥 コントリビュート

コントリビュートを歓迎します。詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

**対象レベル**: 300 (Intermediate)

---

**注意**: これはリファレンス実装です。本番利用の前に、MFA の強制、WAF と脅威保護の追加、パスワード認証フローの無効化を行ってください。
