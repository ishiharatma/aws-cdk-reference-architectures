# ALB + Keycloak 認証 (ECS Fargate + Aurora Serverless V2)

## 概要

このワークスペースは、AWS ALB のユーザー認証に **Keycloak** を使用した参照アーキテクチャです。

### コンポーネント

| コンポーネント | 役割 |
|---|---|
| ALB (Application Load Balancer) | ユーザーリクエストの受付・OIDC 認証の実行 |
| Keycloak (ECS Fargate) | OIDC/SAML 認証プロバイダー |
| Aurora Serverless V2 (PostgreSQL) | Keycloak のセッション・設定の永続化 |
| Secrets Manager | DB 認証情報・管理者パスワードの管理 |

---

## アーキテクチャ

### Pattern A — Keycloak 直接認証 (OIDC)

```
                         ┌─────────────────────────────────────────────────┐
                         │ VPC                                              │
                         │                                                  │
 Internet ──► App ALB ──► App ECS (nginx)                                  │
             (OIDC Auth) │                                                  │
                │        │                                                  │
                │ OIDC   │                                                  │
                ▼        │                                                  │
          Keycloak ALB ──► Keycloak ECS ──► Aurora Serverless V2           │
                         │  (ECS Fargate)    (PostgreSQL)                   │
                         └─────────────────────────────────────────────────┘
```

**認証フロー**:
1. ユーザーが App ALB にアクセス
2. ALB が Keycloak の OIDC エンドポイントにリダイレクト
3. ユーザーが Keycloak でログイン
4. Keycloak が ALB にトークンを返す
5. ALB がバックエンドにリクエストを転送（`X-Amzn-Oidc-*` ヘッダー付き）

### Pattern B — SAML 連携 (Keycloak ブローカー)

```
 Internet ──► App ALB ──► App ECS
             (OIDC Auth)
                │
                │ OIDC
                ▼
          Keycloak (OIDC Provider)
                │
                │ SAML
                ▼
          外部 SAML IdP (ADFS / Okta / Azure AD 等)
```

Keycloak が OIDC Provider (ALBから見た場合) かつ SAML Service Provider (IdP から見た場合) として機能します。

---

## スタック構成

```
AlbKeycloakAuthStage
├── {Project}Base      — VPC + Security Groups
├── {Project}Database  — Aurora Serverless V2
├── {Project}Keycloak  — Keycloak ECS Fargate + Keycloak ALB
└── {Project}App       — バックエンド ECS + App ALB
```

---

## デプロイ手順

### 前提条件

```bash
cd infrastructure
npm install
```

### Step 1: インフラのデプロイ

```bash
cd workspaces/alb-keycloak-auth

# CDK bootstrap (初回のみ)
PROJECT=myproject ENV=dev npm run bootstrap

# デプロイ
PROJECT=myproject ENV=dev npm run deploy:all
```

デプロイ後、Outputs に以下が出力されます:

| Output | 内容 |
|---|---|
| `KeycloakAlbDns` | Keycloak ALB の DNS 名 |
| `AdminSecretArn` | Keycloak 管理者認証情報のシークレット ARN |
| `AppAlbDns` | アプリケーション ALB の DNS 名 |
| `OidcClientSecretArn` | OIDC クライアントシークレット ARN |

### Step 2: Keycloak セットアップ (Pattern A)

Keycloak が起動するまで約 2〜3 分かかります。

```bash
export PROJECT=myproject
export ENV=dev
export KC_URL=http://$(aws cloudformation describe-stacks \
  --query "Stacks[?contains(StackName,'Keycloak')].Outputs[?OutputKey=='KeycloakAlbDns'].OutputValue" \
  --output text)
export REALM=myrealm
export APP_ALB_URL=https://your-app-domain.com  # App ALB URL

./scripts/keycloak-setup.sh
```

このスクリプトが実行すること:
- Keycloak レルムの作成
- ALB 用 OIDC クライアントの作成
- クライアントシークレットを Secrets Manager に保存

### Step 3: OIDC 認証の有効化

`parameters/dev-params.ts` を編集:

```typescript
oidcConfig: {
  enabled: true,  // false から true に変更
  clientId: 'alb-client',
},
appDomainName: 'app.example.com',       // 必須 (HTTPS が必要)
appHostedZoneId: 'Z1234567890ABC',
```

再デプロイ:

```bash
PROJECT=myproject ENV=dev npm run deploy:all
```

---

## Pattern B: SAML 連携設定

Pattern A のセットアップ完了後、以下を実行します:

```bash
export SAML_IDP_ALIAS=corp-saml
export SAML_IDP_DISPLAY_NAME='Corporate SSO'
export SAML_IDP_METADATA_URL=https://your-idp.example.com/saml/metadata

./scripts/saml-setup.sh
```

その後、以下の URL を IdP 管理者に共有し、SP として登録してもらいます:

```
http://<Keycloak-ALB-DNS>/realms/myrealm/protocol/saml/descriptor
```

---

## 接続テスト

### 1. Keycloak ヘルスチェック

```bash
curl http://<Keycloak-ALB-DNS>/health/ready
# → {"status":"UP",...}
```

### 2. OIDC ディスカバリー確認

```bash
curl http://<Keycloak-ALB-DNS>/realms/myrealm/.well-known/openid-configuration
```

### 3. App ALB アクセス (OIDC 無効時)

```bash
curl http://<App-ALB-DNS>/
# → nginx のデフォルトページ
```

### 4. App ALB アクセス (OIDC 有効時)

ブラウザで `https://<App-ALB-DNS>/` にアクセスすると Keycloak ログイン画面にリダイレクトされます。

### 5. ECS Exec で Keycloak コンテナに接続

```bash
# クラスター名・タスク ID を取得
CLUSTER=myproject-dev-keycloak
TASK_ID=$(aws ecs list-tasks --cluster ${CLUSTER} --query 'taskArns[0]' --output text)

aws ecs execute-command \
  --cluster ${CLUSTER} \
  --task ${TASK_ID} \
  --container keycloak \
  --interactive \
  --command '/bin/bash'
```

### 6. Aurora 接続確認 (Keycloak コンテナ内から)

```bash
# コンテナ内で実行
psql -h <aurora-endpoint> -U keycloak -d keycloakdb -c 'SELECT version();'
```

---

## パラメーター説明

| パラメーター | 説明 | デフォルト |
|---|---|---|
| `keycloakConfig.keycloakVersion` | Keycloak イメージバージョン | `26.1` |
| `keycloakConfig.realmName` | 作成するレルム名 | `myrealm` |
| `auroraConfig.serverlessV2MinCapacity` | Aurora 最小 ACU | `0.5` |
| `oidcConfig.enabled` | ALB OIDC 認証の有効化 | `false` |
| `keycloakDomainName` | Keycloak カスタムドメイン (HTTPS 用) | 未設定 |
| `appDomainName` | App カスタムドメイン (OIDC 有効化に必要) | 未設定 |
| `samlConfig` | SAML IdP 設定 | 未設定 |

---

## コスト概算 (ap-northeast-1, 開発環境)

| リソース | 概算コスト |
|---|---|
| ECS Fargate (Keycloak, 1 task, 1vCPU/2GB) | ~$35/月 |
| ECS Fargate (App, 1 task, 0.25vCPU/0.5GB) | ~$5/月 |
| Aurora Serverless V2 (最小 0.5 ACU) | ~$15/月 |
| ALB x2 | ~$35/月 |
| NAT Instance | ~$10/月 |
| **合計** | **~$100/月** |

> 開発時は NAT スケジュール機能で NAT を夜間停止してコスト削減できます。

---

## セキュリティ考慮事項

- Keycloak 管理コンソールは本番環境では IP 制限またはプライベート ALB を使用してください
- `appDomainName` を設定して HTTPS を有効化することを強く推奨します
- Aurora の認証情報は Secrets Manager で管理され、コンテナに安全に注入されます
- ECS Exec を有効化しているため、デプロイ後に IAM ポリシーで制限することを推奨します
