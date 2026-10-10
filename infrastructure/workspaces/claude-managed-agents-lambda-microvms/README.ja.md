# Claude Managed Agents on AWS Lambda MicroVMs — イベント駆動のコントロールプレーンで動かすセルフホスト型サンドボックス

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## はじめに

[Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes) のうち、ツールを実行する側を自分の AWS アカウントで動かすリファレンス実装です。エージェントループ、モデル、セッション状態、作業キューは Anthropic が持ちます。セッションごとのツール呼び出しは、Webhook を受けたランチャーが起動する専用の [AWS Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-claude-managed-agents.html) で実行され、セッションが終わると MicroVM は自分で終了します。

AWS のサンプル [sample-lambda-microvm-claude-managed-agents](https://github.com/aws-samples/sample-lambda-microvm-claude-managed-agents)(SAM 製)を CDK(TypeScript)に移植し、本番利用で足りない部分を補っています。具体的には、ドメインで絞った出口、任意のカスタマー管理 KMS キー、アラーム、残留 MicroVM の検知、予算です。

このアーキテクチャで確認できること:

- 入口は Webhook 1本だけ。ランチャーが HMAC 署名を検証し、イベント ID で重複を除き、失敗時は 2xx 以外を返して Anthropic に再送させる
- 秘密情報を読む主体で分離。ランチャーは署名シークレットだけ、MicroVM は環境キーだけを読み、Organization API キーは AWS 上のコンピュートに置かない
- セッション1つにつき MicroVM 1つ。ワーカーの自己終了、アイドルポリシー、`maximumDurationInSeconds` の3段で寿命を管理する
- 出口の切り替え。AWS マネージドの `INTERNET_EGRESS` か、AWS Network Firewall のドメイン許可リストを通す VPC 出口コネクタ
- 入口の切り替え。サンプルと同じ `ALL_INGRESS` か、ワーカーが外向き通信しかしない前提の `NO_INGRESS`
- 運用の仕組みを同梱。Webhook の拒否、`RunMicrovm` の失敗、クォータ超過とスロットリング、想定より長く残る MicroVM のアラーム

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [実機デプロイ検証](#-実機デプロイ検証)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![アーキテクチャ概要](overview.drawio.svg)

着信は Webhook 1本だけです。その後はすべて pull 型で、MicroVM 内のワーカーが Anthropic へ作業を取りに行くため、Anthropic が MicroVM へ接続することはありません。

```
Anthropic ──Webhook──▶ WAF ─▶ API Gateway ─▶ ランチャー Lambda ──RunMicrovm──▶ MicroVM(セッションごとに1つ)
                                              ├─ SSM: 署名シークレット               ├─ SSM: 環境キー
                                              └─ DynamoDB: イベント ID の重複排除    ├─ Anthropic から作業を取得(HTTPS)
                                                                                    └─ 完了後に自分自身へ TerminateMicrovm
```

### 主要コンポーネント

- **WAF + API Gateway(REST)**: `POST /webhook`。ボディのスキーマ検証、AWS マネージドルール(Common、Known Bad Inputs、IP Reputation)、IP ごとのレート制限を入れています。これはリクエストの衛生管理で、認証ではありません。
- **ランチャー Lambda**(`src/launcher/index.ts`、Node.js 22、arm64): 生のボディに対して Standard Webhooks の署名を検証し、`session.status_run_started` 以外は無視し、イベント ID を DynamoDB に条件付きで書き込んでから `RunMicrovm` を呼びます。Run フックのペイロードに入るのは、セッション ID、環境 ID、環境キーのパラメータ**名**だけです。
- **MicroVM イメージ**(`AWS::Lambda::MicrovmImage`): `src/microvm-image/`(Dockerfile と Node.js ワーカー)からサービスがビルドします。ワーカーはライフサイクルフックに応答し、`/run` にはすぐ 200 を返し、自分のロールで環境キーを読み、自分のセッションの作業だけをキューから取り、ツール呼び出しを処理します。
- **実行ロール**: SecureString 1つの読み取り、ログ書き込み、`lambda:TerminateMicrovm`。
- **SSM パラメータストアの SecureString**: 環境キーと Webhook 署名シークレット。CloudFormation は SecureString を作れないため、初回デプロイ後に `scripts/put-secrets.sh` で書き込みます。
- **DynamoDB**: 冪等性テーブル(パーティションキー `id`、`expiration` で TTL)。
- **残留検知**(EventBridge で10分ごと → Lambda): イメージの MicroVM を列挙し、`RunningMicrovms` と `StaleMicrovms` のメトリクスを送ります。
- **アラーム → SNS(KMS 暗号化) → メール**。月額の AWS Budgets は任意です。
- **出口 VPC**(`egressMode: 'firewall'` のときだけ): ワークロード、ファイアウォール、パブリックの3サブネットを持つ VPC、ドメイン許可リスト付きの Network Firewall、NAT ゲートウェイ、VPC 出口タイプの `AWS::Lambda::NetworkConnector`。

### アーキテクチャの特性

| 特性 | 値 | 理由 |
|------|----|------|
| 可用性 | リージョナルなマネージドサービス。任意の出口 VPC は1 AZ | コントロールプレーンにフェイルオーバーするサーバーはありません。出口 VPC は1 AZ のリファレンスで、本番では AZ ごとにファイアウォールエンドポイントと NAT ゲートウェイが必要です |
| スケーラビリティ | セッション1つにつき MicroVM 1つ。同時実行数はアカウントの MicroVM メモリクォータで決まる | セッションは独立しているので、規模の問題はクォータの問題です。`RunMicrovm` にはレート制限があり、2xx 以外を返せば Anthropic が再送します |
| セキュリティ | 署名検証済みの Webhook、読む主体ごとに分けた秘密情報、AWS 上に Organization API キーを置かない | ランチャーは MicroVM を起動できても環境キーは読めず、MicroVM は環境キーを読めても MicroVM を起動できません |
| コスト | MicroVM の稼働中だけ課金。常時かかるのは WAF、API Gateway、アラーム程度 | 完了したセッションは自分の MicroVM を終了します |

## 🎯 設計判断とベストプラクティス

### 1. 入口は Webhook、出口は pull

**決定**: Anthropic はランチャーへ Webhook を1本送り、ワーカーは外向きの HTTPS で Anthropic から作業を取得します。

**理由**:
- ✅ MicroVM に受け付けるポートがなく、`ingressMode: 'none'` にできる
- ✅ ランチャーは検証、重複排除、起動だけの小さな構成で済む
- ✅ 再送は Anthropic の役割になり、2xx 以外を返せばイベントが再配信される

**トレードオフ**:
- ❌ アイドルポリシーは MicroVM エンドポイントへのトラフィックで判定されるが、pull 型のワーカーには着信がない(判断4を参照)
- ❌ Anthropic API に届かない MicroVM はすぐ終了する。出口の許可リストを狭くしすぎると起きやすい

### 2. 秘密情報は読む主体ごとに分ける

**決定**: ランチャーには署名シークレットへの `ssm:GetParameter` だけ、MicroVM の実行ロールには環境キーへの `ssm:GetParameter` だけを付与します。Run フックのペイロードにはパラメータの**名前**を入れ、値は入れません。

**理由**:
- ✅ ランチャーが侵害されてもワーカーになりすませず、MicroVM が侵害されても Webhook を偽造できない
- ✅ 既定の `alias/aws/ssm` キーの ARN は合成時に分からないため、`kms:Decrypt` は `kms:ViaService` と `PARAMETER_ARN` 暗号化コンテキストで縛り、各ロールが復号できるパラメータを1つに限る

**トレードオフ**:
- ❌ 値は CloudFormation の外で書き込む(`scripts/put-secrets.sh`)

### 3. Webhook のイベント ID で冪等にする

**決定**: `RunMicrovm` の前にイベント ID を条件付き `PutItem` で書き、同じ ID を `clientToken` にも使います。`RunMicrovm` が失敗したらレコードを削除して 502 を返します。

**理由**:
- ✅ 再送や同時配信があっても MicroVM は1つだけ起動する
- ✅ 失敗時にレコードを消すので、再送が重複として握りつぶされずに成功できる

**トレードオフ**:
- ❌ 運用するテーブルが1つ増える。TTL は MicroVM の最大寿命と同じ

### 4. 寿命の3段管理

**決定**: セッションが終わるとワーカーが自分に `TerminateMicrovm` を呼びます。保険としてアイドルポリシー、全体の上限として `maximumDurationInSeconds`(既定4時間、`microvm.maxLifetimeSeconds`)を置きます。

**理由**:
- ✅ 主経路ですぐ計算資源を解放できる
- ✅ 保険ごとに守る障害が違う。終了前にクラッシュしたワーカーと、終わらないセッション
- ✅ 残留検知が、自己終了の漏れをアラームにする

**トレードオフ**:
- ❌ AWS ドキュメントの推奨値は `maxIdleDurationSeconds: 120`、`suspendedDurationSeconds: 0` です。アイドルはエンドポイントのトラフィックで判定されるため、着信のないワーカーは長いツール実行の途中でサスペンドされ、そのまま終了する可能性があります。このパターンの既定は600秒で、パラメータにしています。短くする前に、アイドル時間より長いツール実行を含むセッションで挙動を確認してください

### 5. 出口はマネージドコネクタか、検査付きの VPC 経路か

**決定**: `network.egressMode` は `internet`(AWS マネージドの `INTERNET_EGRESS`。サンプルと同じ)か `firewall` です。

**理由**:
- ✅ `firewall` では MicroVM が `network.allowedDomains` のドメイン(HTTP ホストと TLS SNI)にしか出られない。任意のツールコードを実行するエージェントが、任意の宛先へ通信できなくなる
- ✅ ワークロードサブネット自身にインターネットへのルートはなく、既定ルートはファイアウォールエンドポイントへ向く。ファイアウォールサブネットは NAT ゲートウェイへ、パブリックサブネットはワークロードサブネットの CIDR をファイアウォール経由で戻すため、往復が同じステートフルエンジンを通る
- ✅ コネクタのセキュリティグループは TCP 443 の外向きだけを許可し、内向きは許可しない

**トレードオフ**:
- ❌ Network Firewall のエンドポイントと NAT ゲートウェイは時間課金([コスト最適化](#-コスト最適化)を参照)
- ❌ 既定の許可リストには、ワーカーが SSM と `TerminateMicrovm` に届くよう `.amazonaws.com` を含めている。正確なエンドポイントへの絞り込みや VPC エンドポイントの追加が次の強化策
- ❌ 1 AZ

### 6. 入口の切り替え

**決定**: `network.ingressMode` は `all`(`ALL_INGRESS`。サンプルと同じ)か `none`(`NO_INGRESS`)です。

**理由**:
- ✅ ワーカーは着信接続を必要としないため、`none` にすると MicroVM のエンドポイントが攻撃面から消える

**トレードオフ**:
- ❌ `NO_INGRESS` でもライフサイクルフックが届くかは、初回デプロイで確認する項目([実機デプロイ検証](#-実機デプロイ検証)を参照)

### 7. カスタマー管理キー(任意)

**決定**: `secrets.useCustomerManagedKey: true` でローテーション付きのキーとエイリアスを作り、IAM ステートメントの対象を `*` からそのキーに変えます。`put-secrets.sh` はエイリアスを `--key-id` に渡します。

**理由**:
- ✅ キーポリシーが、秘密情報を読める主体への2つ目の制御になる。復号が自分のキーの CloudTrail に残る

**トレードオフ**:
- ❌ キー1つにつき月額 $1

### 8. AWS サンプルとの違い

| 項目 | AWS サンプル(SAM + Python) | このパターン(CDK + TypeScript) |
| --- | --- | --- |
| ランチャー | Python と Powertools | Node.js 22。署名検証は Anthropic の TypeScript SDK。AWS SDK を同梱 |
| 冪等性 | Powertools Idempotency | 条件付き `PutItem`。`RunMicrovm` 失敗時はレコードを削除。`clientToken` も設定 |
| イメージビルド | `build-image.sh` と CLI | スタック内の `AWS::Lambda::MicrovmImage`。CDK アセットからビルド |
| 出口 | `INTERNET_EGRESS` のみ | Network Firewall 付きの VPC コネクタへ切り替え可能 |
| 入口 | `ALL_INGRESS` のみ | `NO_INGRESS` へ切り替え可能 |
| アイドルポリシー | アイドル300秒、サスペンド60秒 | パラメータ化。既定はアイドル600秒、サスペンド0秒 |
| 最大寿命 | 28,800秒 | 14,400秒(パラメータ) |
| KMS | `alias/aws/ssm` | 任意でカスタマー管理キー |
| アラーム、残留検知、予算 | なし | 同梱 |
| WAF | SQL インジェクションのルールグループあり | Common、Known Bad Inputs、IP Reputation、レート制限 |

ワーカー(`src/microvm-image/worker/worker.mjs`)と Dockerfile はサンプルのままです。2つの挙動を比べられます。

### 9. Well-Architected Framework との対応

| 柱 | 実装 |
|----|------|
| **運用上の優秀性** | すべて CDK 化。Webhook の拒否、起動失敗、キャパシティエラー、残留 MicroVM のアラームを SNS へ通知。`scripts/e2e-check.sh` で Anthropic 側に触れずにコントロールプレーンを確認 |
| **セキュリティ** | 生ボディへの署名検証、`kms:Decrypt` を1パラメータに絞った読み主体ごとの分離、WAF、任意のドメイン許可リストと `NO_INGRESS`、任意のカスタマー管理キー、両方の出口モードで CDK Nag の `AwsSolutionsChecks` |
| **信頼性** | 冪等な起動、失敗時に解放されるレコード、Anthropic の再配信、3段の寿命制限、残留検知 |
| **パフォーマンス効率** | スナップショットからの MicroVM は数秒で起動。ランチャーは 512 MB の arm64。同時実行数は MicroVM のクォータに従う |
| **コスト最適化** | MicroVM の稼働中だけ課金、自己終了、寿命の上限、月額予算、有効にしない限り動かないファイアウォール |
| **持続可能性** | ランチャーとワーカーイメージは arm64。待機用の台数を持たない |

## 💰 コスト最適化

単価はリージョンで異なります。実際の見積もりの前に AWS の料金ページで確認してください。以下の MicroVM は米国東部(バージニア北部)の定価で、1 vCPU 秒あたり $0.0000276944、1 GiB 秒あたり $0.0000036667 です。

| 項目 | コストの形 |
| --- | --- |
| MicroVM(1 vCPU、2 GiB 基準) | 稼働1時間あたり約 $0.126。20分のセッションで約 $0.04 |
| API Gateway、Lambda、DynamoDB | リクエスト数とオンデマンドで課金。Webhook はセッションごとに1回なので月数セント |
| WAF | Web ACL とルールは月額、リクエストは従量 |
| CloudWatch | アラーム(5つ)とログ保管 |
| KMS(任意) | キー1つにつき月額 $1 |
| Network Firewall(`firewall` モード) | エンドポイント1つにつき1時間あたり約 $0.4 に GB 単位の処理料金。起動したままなら月約 $290 |
| NAT ゲートウェイ(`firewall` モード) | 1時間あたり約 $0.06 に GB 単位の料金。月約 $45 |

出口 VPC を有効にすると請求の大半はそこになります。`internet` モードには時間課金のネットワーク費用はありません。AZ を2つにすると、ファイアウォールと NAT の料金はほぼ倍になります。

コストの調整:

- `microvm.maxLifetimeSeconds` と `microvm.idlePolicy` で、止まったセッションのコストに上限をかける
- `operations.monthlyBudgetUsd` で、80%と100%に通知する(`operations.alarmEmail` と、Billing での `Project` コスト配分タグの有効化が必要)
- 開発は `network.egressMode: 'internet'`、許可リストが要件になる環境では `firewall`

## 🔒 セキュリティ考慮事項

### ネットワークセキュリティ

1. **入口**: 公開エンドポイントは WAF 配下の `POST /webhook` だけです。署名が正しくないリクエストは 401 になり、`RunMicrovm` に届きません。スキーマに合わないボディは API Gateway が 400 を返します。
2. **出口**: `internet` は任意の宛先に出られます(サンプルと同じ)。`firewall` は `network.allowedDomains` だけを HTTP ホストと TLS SNI で許可し、コネクタのセキュリティグループは TCP 443 のみ許可します。
3. **MicroVM の入口**: `NO_INGRESS` で、MicroVM ごとのエンドポイントに到達できなくなります。

### 実装済みのセキュリティ対策

- ✅ Organization API キーは運用者の端末にだけ置く(使うのは `scripts/create-session.mjs` だけ)
- ✅ ランチャーは環境キーを読まず、MicroVM は署名シークレットを読まない
- ✅ `kms:Decrypt` を `kms:ViaService` と `PARAMETER_ARN` 暗号化コンテキストで制限
- ✅ タイムスタンプも確認する署名検証(古い配信は SDK が拒否する)
- ✅ DynamoDB、SNS、アラーム用トピックのキーを暗号化。SNS は TLS を必須にしている
- ✅ `lambda:PassNetworkConnector` は AWS マネージドのコネクタと、カスタマーのコネクタ1つに限定
- ✅ すべての Lambda ロググループに保持期間を設定
- ✅ MicroVM の終了権限は `*` に付与(MicroVM ID は実行前に存在しないため)。そのステートメントにはこの1アクションだけが入っている

### CDK Nag

```bash
npm run test:compliance -w claude-managed-agents-lambda-microvms
```

両方の出口モードを `AwsSolutionsChecks` に通しています。抑制(Lambda のマネージド実行ポリシー、実行時に決まる MicroVM ID、オーソライザーの代わりの HMAC、アカウント単位の API Gateway ログ用ロール)には、それぞれ `test/compliance/cdk-nag.test.ts` に理由を書いています。

## 📋 前提条件

- Lambda MicroVMs が使えるリージョンの AWS アカウント。`lambda-microvms` のサービスモデルが入った AWS CLI(`aws lambda-microvms help` が動くこと)
- Node.js 22 以降、AWS CDK 2.x、Git
- Claude Console 側に、エージェント(`agent_...`)、`self_hosted` 環境(`env_...`)、その環境キー、署名シークレット(`whsec_...`)が返る Webhook の登録
- デプロイ権限: CloudFormation、IAM、Lambda(MicroVM イメージとネットワークコネクタを含む)、API Gateway、WAFv2、DynamoDB、SSM、KMS、CloudWatch、SNS、EventBridge、S3(CDK アセット)、Budgets。`firewall` モードでは EC2 と Network Firewall も

## 🚀 デプロイ手順

### 1. クローンとセットアップ

```bash
git clone https://github.com/ishiharatma/aws-cdk-reference-architectures.git
cd aws-cdk-reference-architectures/infrastructure
npm install
cd workspaces/claude-managed-agents-lambda-microvms
```

### 2. 環境パラメータの設定

[parameters/dev-params.ts](parameters/dev-params.ts) を編集するか、読み込まれる環境変数を使います。`ANTHROPIC_ENVIRONMENT_ID`、`EGRESS_MODE`(`internet` か `firewall`)、`INGRESS_MODE`(`all` か `none`)、`ALARM_EMAIL` です。

```bash
export ANTHROPIC_ENVIRONMENT_ID=env_...
export ALARM_EMAIL=you@example.com   # 任意
```

### 3. コントロールプレーンとイメージのデプロイ

```bash
export PROJECT=<project>  ENV=dev
npm run bootstrap
npm run stage:deploy:all
```

`AWS::Lambda::MicrovmImage` が、デプロイ中にイメージをビルドします。ビルドログは出力 `MicrovmLogGroupName` のロググループにあります。

### 4. Webhook の登録とシークレットの保存

1. Claude Console で、`self_hosted` 環境の環境キーを発行します。
2. スタック出力の `WebhookUrl` を、`session.status_run_started` を購読する Webhook として登録し、署名シークレットを控えます。
3. 2つのシークレットを書き込みます。スクリプトは環境変数から値を読むので、シェルの履歴に残りません。

```bash
ENV_KEY=<environment-key> SIGNING_SECRET=whsec_... \
  ./scripts/put-secrets.sh <project>-dev-claude-managed-agents --profile <profile>
```

### 5. 動作確認

```bash
./scripts/e2e-check.sh <project>-dev-claude-managed-agents --profile <profile>
```

署名のない Webhook が 401、不正なボディが 400 になること、イメージが `CREATED` であることを確認し、ワーカーの MicroVM を一覧表示します。続けて、運用者の端末だけで次を実行します。

```bash
ANTHROPIC_API_KEY=sk-ant-... ANTHROPIC_ENVIRONMENT_ID=env_... AGENT_ID=agent_... \
  node scripts/create-session.mjs "作業ディレクトリのファイルを一覧してください"
aws lambda-microvms list-microvms --image-identifier <出力 MicrovmImageArn> --profile <profile>
aws logs tail <出力 MicrovmLogGroupName> --follow --profile <profile>
```

セッションの開始から数秒で `RUNNING` の MicroVM が現れ、ツール呼び出しを処理し、セッションの完了とともに消えます。

## 🧪 テスト戦略

### テスト構成

```
test/
├── helpers.ts          # テスト用パラメータとオーバーライドでスタックを作る
├── parameters/         # 固定のテスト用パラメータ(スナップショットを安定させる)
├── snapshot/           # テンプレート全体とリソース数(両方の出口モード)
├── unit/               # stack.test.ts: リソース、IAM の分離、ルーティング、アラーム / launcher.test.ts: ランチャーのロジック
└── compliance/         # CDK Nag の AwsSolutionsChecks(両方の出口モード)
```

### 1. スナップショットテスト

**目的**: `internet` と `firewall` の両モードで、テンプレートの変化とリソース数の変化(つまりコストの変化)を検知します。アセットのハッシュは正規化しています。

```bash
npm run test:snapshot
npm run test:snapshot:update   # 意図した変更のあと
```

### 2. ユニットテスト

**目的**: 設計を支えるプロパティを確認します。

**テストカテゴリ**:
- ✅ MicroVM イメージのフックとポート
- ✅ 読む主体ごとの秘密情報の分離、`kms:Decrypt` の条件、カスタマー管理キーの場合
- ✅ ランチャーの環境変数。コネクタ、アイドルポリシー、寿命、値ではなくパラメータ名
- ✅ Webhook API。ボディ検証、WAF の関連付け、レート制限
- ✅ ファイアウォールモード。コネクタ、ルールグループの対象、ルートテーブルの向き先、コネクタのセキュリティグループ
- ✅ ランチャーのロジック(本物の Standard Webhooks 署名を使用)。署名なし、別のシークレット、古いタイムスタンプは 401。他のイベントは無視。重複配信では起動しない。`RunMicrovm` が失敗したら重複排除レコードを解放して 502
- ✅ アラーム、メトリクスフィルター、残留検知のスケジュール、予算、任意設定

```bash
npm run test:unit
```

### 3. コンプライアンステスト

```bash
npm run test:compliance
```

## ⚙️ カスタマイズ

### 出口のドメインを絞る

```typescript
network: {
  egressMode: 'firewall',
  ingressMode: 'none',
  allowedDomains: ['api.anthropic.com', 'ssm.ap-northeast-1.amazonaws.com', 'registry.npmjs.org'],
},
```

ツールが必要とする宛先は、すべて加えてください。足りない宛先は、ファイアウォールのアラートログ(出力 `FirewallAlertLogGroup`)に `blocked` として出ます。

### セッションの長さとアイドルの扱い

```typescript
microvm: {
  maxLifetimeSeconds: 7200,
  idlePolicy: { maxIdleDurationSeconds: 1800, suspendedDurationSeconds: 0, autoResumeEnabled: false },
},
```

### カスタマー管理キー

```typescript
secrets: { useCustomerManagedKey: true },
```

### エージェントに使わせるツール

`src/microvm-image/Dockerfile` に追加し(arm64 版、バージョン固定)、再デプロイします。アセットのハッシュが変わるため、イメージは再ビルドされます。

## ✅ 実機デプロイ検証

2026-10-09 に `ap-northeast-1` で実機検証しました。スタックの作成は `internet` モードで264秒、出口 VPC を含めると約11分です(ネットワークコネクタの作成に約4分)。検証後にスタックは削除済みです。

確認できたこと:

- Dockerfile とワーカーをサンプルのまま使って、イメージのビルドが初回デプロイで `CREATED` に達する
- 署名のない Webhook が 401、不正なボディが 400 になる(`scripts/e2e-check.sh`)
- 保存した署名シークレットで署名した Webhook が、`RunMicrovm` で MicroVM を起動する。`/run` フックが届き、ワーカーが実行ロールで環境キーを読み、Anthropic API に届き、自分で終了する(`TERMINATED`)
- `ingressMode: 'none'`(`NO_INGRESS`)でも `/run` フックが届く
- `firewall` モードで、ワーカーが VPC コネクタと Network Firewall を通って SSM と Anthropic API に届く(フローログに MicroVM の ENI から 443 への通信が出る)。許可リストから `api.anthropic.com` を外すと、ワーカーのリクエストはタイムアウトし、アラートログに `blocked`、`not matching any TLS allowlisted FQDNs`、`api.anthropic.com` が記録される。ルールグループの変更が反映されるまで1〜2分かかる

確認できていないこと:

- 本物の環境キー、署名シークレット、エージェントでのセッション全体(検証はダミーのシークレットで行ったため、Anthropic は `Invalid bearer token` を返した)
- アイドルポリシーのもとで、`maxIdleDurationSeconds` より長いツール実行

実機デプロイで見つかり、修正した不具合: パブリックサブネットの戻りルートの宛先が VPC の CIDR で、すでに local ルートとして存在していました(`The route identified by ... already exists`)。宛先をワークロードサブネットの CIDR に変更しています。詳細は `docs/knowledge/lambda-microvms.md` にあります。

## 🔧 トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| Webhook が 401 を返す | SSM の署名シークレットが Console と違います。`put-secrets.sh` を再実行し、ランチャーのキャッシュ(最大5分)を待つか再デプロイします |
| Webhook が 400 を返す | ボディがイベントのスキーマ(`type`、`id`、`created_at`、`data.type`、`data.id`)に合っていません |
| Webhook が 502 を返す | `RunMicrovm` が失敗しています。ランチャーのログと `RunMicrovmFailed` アラームを確認します。よくある原因は、`lambda:RunMicrovm`、`lambda:PassNetworkConnector`、`iam:PassRole` の不足、イメージ ARN の誤り、クォータです |
| MicroVM が起動しない | Webhook が `session.status_run_started` を購読していないか、繰り返しの失敗で Anthropic がエンドポイントを無効にしています |
| MicroVM がすぐ終了する | `/run` フックがタイムアウトした(`runTimeoutInSeconds`)か、ワーカーが Anthropic API に届いていません(出口) |
| イメージのビルドが失敗する | ビルドのロググループを確認します。ログストリームが1つもない失敗は、ビルドロールにロググループへの書き込み権限がありません |
| ビルドが `ARCHIVE_DOCKERFILE_NOT_FOUND` で失敗する | アセットのルートに Dockerfile がありません |
| `put-secrets.sh` が KMS で `AccessDenied` になる | カスタマー管理キーを使う場合、実行者にそのキーの `kms:Encrypt` が必要です |
| MicroVM が `RUNNING` のまま残る | `StaleMicrovms` アラームが鳴ります。`aws lambda-microvms terminate-microvm` で終了させ、ワーカーのログを確認します |

## 🧹 クリーンアップ

```bash
npm run stage:destroy:all
```

先に、`RUNNING` の MicroVM があれば終了させてください。2つの SecureString パラメータはスタックの管理外なので、`aws ssm delete-parameter` で削除します。カスタマー管理キーは7日間の削除待ち期間に入ります。Claude Console の Webhook 登録と環境キーも削除してください。

## 📚 参考資料

- [Using Lambda MicroVMs as a sandbox for Claude Managed Agents](https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-claude-managed-agents.html)
- [Running and using MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Networking (Lambda MicroVMs)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [MicroVM images](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [Running self-hosted AI agent sandboxes with AWS Lambda MicroVMs(AWS Compute Blog)](https://aws.amazon.com/blogs/compute/running-self-hosted-ai-agent-sandboxes-with-aws-lambda-microvms/)
- [Claude Managed Agents: Self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- [sample-lambda-microvm-claude-managed-agents(aws-samples)](https://github.com/aws-samples/sample-lambda-microvm-claude-managed-agents)
- [AWS Network Firewall: ドメインリストのルールグループ](https://docs.aws.amazon.com/network-firewall/latest/developerguide/stateful-rule-groups-domain-names.html)
