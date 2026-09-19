# Lambda MicroVMsで実現するServerlessなCodex App Server - AWS CDK Reference Architecture

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **出典に関する注記。** このリファレンス実装は、特定のブログ記事の内容を転記したものではなく、AWS Lambda MicroVMsの公開情報
> (`@aws-sdk/client-lambda-microvms` のAPI定義、`AWS::Lambda::MicrovmImage` / `AWS::Lambda::NetworkConnector`
> のCloudFormationリソーススキーマ、AWSの公開発表)から構成しています。実装依頼の元となった記事(note.com)は、
> このセッションのネットワークegressポリシーによりアクセスできませんでした。特に以下の2点は、引用可能なAWS公式情報源で
> **未検証**であることを明記します。実運用前に必ずAWS Lambda MicroVMs Developer Guideで確認してください。
> 1. Lambda MicroVMsがビルド/実行ロールをAssumeする際に使用するIAMサービスプリンシパル名
> 2. 各ライフサイクルフックの実行ファイルをイメージ内のどのパスから探すかという規約

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [Well-Architectedとの整合性](#️-well-architectedとの整合性)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [使い方](#使い方)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Overview](overview.drawio.svg)

セッション**コントロールプレーン**(API Gateway HTTP API + 5つのLambda関数)が、オンデマンドで起動する**データプレーン**セッション
のライフサイクルを仲介します。各セッションは、[`codex app-server`](https://github.com/openai/codex)(OpenAI Codex CLIの
JSON-RPCエージェントプロトコル。Thread/Turn/ItemをWebSocketトランスポート上でやり取りする)を実行するVM分離された
[AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/)です。コントロールプレーンはapp-serverのトラフィックを
一切プロキシしません。セッション開始後、クライアントはMicroVM専用のHTTPSエンドポイントに**直接**接続するため、すべての
JSON-RPCラウンドトリップはVM分離された経路上に留まり、コントロールプレーン側のLambda自体は小さくステートレスなまま保てます。

```
クライアント (IDE / CLI / Web UI)
   │  1. POST /sessions (Cognito JWT)
   ▼
API Gateway HTTP API ── JWT Authorizer (Cognito User Pool)
   │
   ▼
コントロールプレーン Lambda (create / get / delete / suspend / resume)
   │  RunMicrovm / GetMicrovm / SuspendMicrovm / ResumeMicrovm /
   │  TerminateMicrovm / CreateMicrovmAuthToken
   ▼
Lambda MicroVMs データプレーン
   │  codex app-serverイメージからFirecracker MicroVMを起動
   ▼
MicroVM (VM分離、専用HTTPSエンドポイント)
   codex app-server (WebSocket, JSON-RPC Thread/Turn/Item)
   ── AWS::Lambda::NetworkConnector経由でegress → NAT Gateway → OpenAI API

   │  2. WebSocket + X-aws-proxy-authトークンでMicroVMエンドポイントに直接接続
   ▼
クライアント ◄──────────────────────────────────────────────────────────
```

### 主要コンポーネント

| コンポーネント | 役割 |
|---|---|
| `AWS::Lambda::MicrovmImage` (`CfnMicrovmImage`) | `src/microvm-image/Dockerfile`(Node.js + `@openai/codex` + ライフサイクルフックスクリプト)をスナップショット済みMicroVMイメージにパッケージ化。 |
| `AWS::Lambda::NetworkConnector` + VPC (NAT Gateway 1台) | MicroVMの`egressNetworkConnectors`がインターネット(OpenAI API)に到達できる唯一の手段。これがないと`codex app-server`はアウトバウンド通信を一切できません。 |
| Secrets Managerシークレット | OpenAI APIキーを保持。イメージに焼き込まれるのはそのARN(`OPENAI_API_KEY_SECRET_ARN`)のみで、値自体はMicroVM起動時に実行ロールを使って取得します。 |
| 5つのコントロールプレーンLambda | `create-session`(RunMicrovm + CreateMicrovmAuthToken)、`get-session`(GetMicrovm)、`delete-session`(TerminateMicrovm)、`suspend-session`(SuspendMicrovm)、`resume-session`(ResumeMicrovm + 新しい認証トークン発行)。 |
| DynamoDB `SessionsTable` | セッション1件につき1アイテム(`sessionId`, `ownerId`, `microvmId`, `endpoint`, `state`)。TTLで自動失効。 |
| Cognito User Pool + HTTP API JWT Authorizer | すべてのコントロールプレーンルートが有効なCognito JWTを要求。`ownerId`によりセッションの読み書きを作成者本人にスコープします。 |

### MicroVMライフサイクルフック

イメージのDockerfileは、ライフサイクルイベント(`run`, `ready`, `suspend`, `resume`, `terminate`, `validate`)ごとに
1つずつ、計6本のフックスクリプトを`/opt/hooks/`配下に配置します。**重要な注記:** `cdk synth`のCloudFormation Validate
プラグインにより、`Hooks.MicrovmHooks.*`および`Hooks.MicrovmImageHooks.*`は実際にはスクリプトパスの文字列ではなく
`ENABLED`/`DISABLED`のスイッチであることが確認されました。プラットフォームがイメージ内のどのパス規約でフック実行ファイルを
探すのかは、本実装の作成時点で引用可能なAWS公式情報源から確認できませんでした。ここでは妥当と考えられる
`/opt/hooks/<hook>.sh`という規約でスクリプトを配置していますが、AWS Lambda MicroVMs Developer Guideで実際の規約を
確認し、異なる場合は`src/microvm-image/Dockerfile`を調整してください。

| フック | タイミング | 処理内容 |
|---|---|---|
| `ready` / `validate` (イメージビルド時) | Dockerfileのコンテナ起動後 / Firecrackerスナップショット取得後 | `nc -z 127.0.0.1 $CODEX_APP_SERVER_PORT`で`codex app-server`がリッスンするまでポーリング。 |
| `run` | MicroVM PENDING → RUNNING | Secrets ManagerからOpenAI APIキーを取得し、`codex app-server --listen ws://0.0.0.0:$PORT`を起動。 |
| `suspend` / `resume` | RUNNING ⇄ SUSPENDED | ログ出力のみ。プロセス状態(実行中のThread/Turn/Item含む)はFirecracker自身のメモリ+ディスクスナップショットが自動的に保持します。 |
| `terminate` | MicroVM破棄直前 | `codex app-server`のベストエフォートなグレースフルシャットダウン。 |

## 🎯 設計判断とベストプラクティス

### 1. コントロールプレーンはapp-serverトラフィックを一切プロキシしない

`create-session`と`resume-session`は、MicroVM自身の`endpoint`と、単一ポートにスコープされた短命の
`X-aws-proxy-auth`トークン(`CreateMicrovmAuthToken`の`allowedPorts`で発行)を返します。クライアントはこの
エンドポイントに直接接続します。これによりすべてのJSON-RPCメッセージがVM分離された経路上に留まり、コントロール
プレーンLambdaのレイテンシとコストがセッションのトラフィック量から独立します。

### 2. コスト面ではterminateよりsuspendを優先

`idlePolicy`はアイドル状態のMicroVMを終了させるのではなく自動サスペンドします(課金対象はFirecrackerスナップショット
ストレージのみ)。`POST /sessions/{id}/suspend`と`/resume`により、セッションが一時的に不要であるとクライアントが
分かっている場合(タブを閉じたなど)、アイドルタイムアウトを待たずに即座にその遷移をトリガーできます。

### 3. OpenAI APIキーはイメージにもIaCにも一切含まれない

`CfnMicrovmImage.environmentVariables`には`OPENAI_API_KEY_SECRET_ARN`(全セッション共通の固定値)のみが含まれます。
`hooks/run.sh`が、MicroVMの`executionRoleArn`にプラットフォームが注入する認証情報を使ってSecrets Managerから
実際のシークレット値を取得します(`src/microvm-image/hooks/fetch-secret.mjs`参照)。

### 4. セッションはエンドツーエンドで所有者にスコープされる

Cognito JWTの`sub`クレームが`SessionsTable`の各アイテムの`ownerId`になります。`get/delete/suspend/resume`は
いずれも、呼び出し者自身のセッションでない場合は404を返し、他ユーザーのMicroVMエンドポイントを漏洩させません。

### 5. ARNのハードコードではなく環境別パラメータ

`lib/types/microvm-image-params.ts`と`lib/types/control-plane-params.ts`が調整可能な項目(ベースイメージ
ARN/バージョン、メモリ、アイドル/サスペンドタイムアウト、認証トークンTTL)を定義し、`parameters/dev-params.ts`が
`dev`環境の値を供給します。**`baseImageArn`/`baseImageVersion`はプレースホルダーのまま出荷されます** -- 「前提条件」
を参照してください。

## 🏛️ Well-Architectedとの整合性

| 柱 | 本リファレンスでの対応 |
|---|---|
| 運用上の優秀性 | HTTP APIステージのCloudWatchアクセスログ、コントロールプレーンLambdaごと・MicroVMイメージごとの専用CloudWatchロググループ。 |
| セキュリティ | セッションごとのVMレベル分離(Firecracker、カーネル非共有)、全ルートでのCognito JWT認可、所有者スコープのセッションレコード、最小権限のDynamoDB/Secrets Manager権限。 |
| 信頼性 | DynamoDB PAY_PER_REQUEST + ポイントインタイムリカバリ。NAT Gatewayを1台のみとしているのは意図的なコスト/AZ耐性のトレードオフです -- 本番環境ではAZごとにNAT Gatewayを追加してください。 |
| パフォーマンス効率 | MicroVMは事前初期化済みのFirecrackerスナップショットから再開するためコールドブートせず、セッション開始/再開時には`codex app-server`が既にリッスンしています。 |
| コスト最適化 | `idlePolicy`による自動サスペンド、失効セッションのDynamoDB TTL、全体を通したPAY_PER_REQUEST課金。 |

## 💰 コスト最適化

本リファレンスは、このリポジトリの他のパターンにはないコスト要素(MicroVMの実行/サスペンド時間、NAT Gateway、
Cognito)を含みます。**ここに記載する内容を見積もりとして扱わないでください** -- 実際のワークロードのコストを
見積もる前に、必ずご利用リージョンのAWS料金ページ(Lambda MicroVMs、NAT Gateway、Cognito、DynamoDB)を確認してください。

このアーキテクチャで重要度が高い順に、おおまかなコスト*要因*を挙げます。

1. **MicroVMのRUNNING時間** -- セッションのMicroVMが稼働中の間課金されます(稼働中のCodexセッションにおける主要因)。
2. **MicroVMのSUSPENDED時間** -- Firecrackerスナップショットのストレージのみが課金対象です。これが、レイテンシ
   だけでなくコストの観点からも`idlePolicy`と明示的な`/suspend`ルートが重要である理由です。
3. **NAT Gateway** -- 時間単位の課金に加え、`codex app-server`がOpenAI APIとの間で送受信する全バイトに対する
   データ処理料金がかかります。NAT Gatewayを1台のみとする構成(本リファレンスのデフォルト)が最も安価な構成です。
   インターネットegress以外にMicroVMが必要とするAWSサービス通信があれば、VPCエンドポイントの利用を検討してください。
4. **Cognito** -- MAU課金が始まるまで無料利用枠が一定数のMAUをカバーします。Plus機能プラン(`AwsSolutions-COG8`、
   本実装ではサプレッション済み)を有効化すると、さらにMAU単位の追加コストが発生します。
5. **API Gateway HTTP API + コントロールプレーンLambda** -- 上記に比べれば無視できる程度です。コントロールプレーン
   はセッションライフサイクルの呼び出しのみを仲介し、app-server本体のトラフィックは扱いません。
6. **DynamoDB** -- PAY_PER_REQUESTと短いTTLにより、典型的なセッション量ではほぼゼロに近いコストに抑えられます。

### このパターン固有のコストに関する補足

- コストに敏感な環境では`controlPlane.idleTimeoutInMinutes`を短くしてください。アイドルウィンドウを短くすると
  未使用のMicroVMがより早くサスペンドされますが、次のリクエスト時にレジュームのラウンドトリップが発生します。
- `controlPlane.suspendedDurationInMinutes`は、放置されたセッションがプラットフォームによって完全に終了される
  までスナップショットストレージ料金を払い続ける期間の上限です。`sessionRecordTtlInDays`と整合させてください。

## 🔒 セキュリティ考慮事項

### 実装済み

- セッションごとのVMレベル分離(Firecracker MicroVM、セッション間でカーネルを共有しない)。
- 全コントロールプレーンルートでのCognito JWT認可(`HttpUserPoolAuthorizer`)。
- 所有者スコープのセッションレコード(JWTの`sub`クレームに由来する`ownerId`)。
- OpenAI APIキーはSecrets Managerにのみ存在し、イメージに焼き込まれるのはそのARNのみ。
- 最小権限のDynamoDB(`grantReadWriteData`を`SessionsTable`にスコープ)およびSecrets Manager
  (`grantRead`を対象シークレット1つにスコープ)の権限付与。
- MicroVM egress経路用のアウトバウンド専用セキュリティグループ(インバウンドルールなし)。

### 意図的にスコープ外(環境ごとに追加してください)

- HTTP API向けのWAFv2 Web ACL。
- Lambdaハンドラ自身が行う以上のリクエストボディ/スキーマバリデーション。
- CognitoのMFAおよびPlus機能プラン(高度なセキュリティ機能)。
- VPCフローログ。
- Secrets Managerの自動ローテーション(ローテーション用Lambdaを持たないサードパーティAPIキーには適用不可。手動でローテーションしてください)。

### 本番利用前に検証すべき2点

1. **IAM信頼ポリシー。** スタック内の`microvmServicePrincipal`は、Lambda MicroVMsがイメージビルドおよびMicroVM実行の
   際にAssumeするプリンシパルとして`lambda.amazonaws.com`を最有力の推測値として使用しています。実際に必要な
   プリンシパル(および`sts:ExternalId`等の条件キー)をAWS Lambda MicroVMs Developer Guideで確認してください。
2. **フック実行ファイルのパス規約。** 上記「MicroVMライフサイクルフック」を参照してください。

### CDK Nag

`test/compliance/cdk-nag.test.ts`が`AwsSolutionsChecks`パックを実行し、サプレッションされていない警告/エラーが
ゼロであることを検証します。各サプレッションは上記の「意図的にスコープ外」項目のいずれかに紐づく理由を持ち、
加えて`lambda-microvms:*`アクション向けの`AwsSolutions-IAM5`も含みます(これらのリソースARN -- MicroVMおよびイメージの
識別子 -- は`RunMicrovm`実行時に採番されるため、デプロイ前にスコープを絞り込めません)。

## 📋 前提条件

- Node.js 20.x以降、AWS CDK CLI、リポジトリルートのREADMEに記載のAWSプロファイル設定。
- **実在するMicroVMベースイメージのARNとバージョン。** `parameters/dev-params.ts`はプレースホルダー
  (`baseImageArn: 'arn:aws:lambda-microvms:...:image/REPLACE_ME'`)で出荷されます。以下のコマンドで実際の値を
  取得し、デプロイ前に`parameters/dev-params.ts`を更新してください。
  ```sh
  aws lambda-microvms list-managed-microvm-images
  ```
- 対象アカウント/リージョンでのAWS Lambda MicroVMsへのアクセス(本実装作成時点ではプレビュー/限定提供機能の
  可能性があります -- アカウントで有効化されているか確認してください)。
- 初回デプロイ後に`OpenAiApiKeySecret`(そのARNはスタック出力に含まれます)へ設定するOpenAI APIキー。

## 🚀 デプロイ手順

```sh
cd infrastructure
npm install

# 1. parameters/dev-params.ts を実際のbaseImageArn/baseImageVersionの値に編集する

# 2. デプロイ
npm run deploy:all -w workspaces/lambda-microvms-codex-appserver --project=<project> --env=dev

# 3. OpenAI APIキーを設定する（ARNはスタック出力の OpenAiApiKeySecretArn から取得）
aws secretsmanager put-secret-value \
  --secret-id <OpenAiApiKeySecretArn> \
  --secret-string 'sk-...'

# 4. 認証用のCognitoユーザーを作成する（UserPoolIdはスタック出力から取得）
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com
aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> --username you@example.com \
  --password '<強力なパスワード>' --permanent
```

## 使い方

```sh
# User Pool Client（スタック出力の UserPoolClientId）で認証してIDトークンを取得し、セッションを開始する:
curl -X POST "$API_URL/sessions" -H "Authorization: Bearer $ID_TOKEN"
# => { "sessionId": "...", "state": "PENDING", "endpoint": "https://...", "authToken": { "X-aws-proxy-auth": "..." } }

# `endpoint`にWebSocketで直接接続し、`authToken`のX-aws-proxy-authヘッダーを付与した上で、
# そこからcodex app-serverのJSON-RPCプロトコル(initialize -> thread/turn/item)を実施する。

# 終了時:
curl -X DELETE "$API_URL/sessions/$SESSION_ID" -H "Authorization: Bearer $ID_TOKEN"
```

## 🧪 テスト戦略

```sh
npm run test:unit -w workspaces/lambda-microvms-codex-appserver        # リソースプロパティのアサーション
npm run test:snapshot -w workspaces/lambda-microvms-codex-appserver    # テンプレート全体のリグレッション安全網
npm run test:compliance -w workspaces/lambda-microvms-codex-appserver  # cdk-nag AwsSolutionsパック
```

`cdk synth`自体も、`AWS::Lambda::MicrovmImage` / `AWS::Lambda::NetworkConnector`のCloudFormationスキーマに
対してテンプレートを検証します(「CloudFormation Validate」プラグイン)。`hooks`や`cpuConfigurations`を変更した
際は、出力される`W3030`警告に注意してください。

## ⚙️ カスタマイズ

### MicroVMデータプレーンのIAMアクションをさらに絞り込む

アカウント内でMicroVM/イメージリソースの安定したARNパターンが分かっている場合は、`lib/stacks/lambda-microvms-codex-appserver-stack.ts`の
`microvmDataPlanePolicy`にある`resources: ['*']`をそのパターンに置き換え、対応する`AwsSolutions-IAM5`のサプレッションを削除してください。

### AZごとにNAT Gatewayを追加する

`Vpc`コンストラクトの`natGateways: 1`を`natGateways: 2`に変更すると、本番グレードのAZ耐性が得られます(NAT Gatewayの
コストはおおむね倍になります)。

### コントロールプレーンにカスタムドメインを設定する

`DomainMappingOptions`(`aws-apigatewayv2`の`HttpApi`)とACM証明書を追加してください。このリポジトリ内の
`cloudfront-vpc-origin`と同様のパターンに従えます。

## 🔧 トラブルシューティング

### `CfnMicrovmImage`の検証で`cdk deploy`が失敗する

`parameters/dev-params.ts`の`baseImageArn`/`baseImageVersion`を確認してください -- プレースホルダーのままでは
デプロイ時に失敗します。`aws lambda-microvms list-managed-microvm-images`を再実行して現在の値を取得してください。

### `RunMicrovm`は成功するが、クライアントが`codex app-server`に接続できない

最も可能性が高いのは、本実装が推測したフックパス(`/opt/hooks/run.sh`)ではプラットフォームが実行ファイルを見つけられず、
`run`フックが`codex app-server`を実際には起動していないケースです。MicroVMのCloudWatchロググループ
(`MicrovmImageLogGroup`)で`hooks/run.sh`からの`[run]`ログ行を確認してください。出力が一切なければ、AWS Lambda
MicroVMs Developer Guideで実際のフック実行ファイルのパス規約を確認してください。

### `codex app-server`は起動するが即座に認証エラーになる

`OPENAI_API_KEY_SECRET_ARN`環境変数が指すSecrets Managerシークレットの値が、初回デプロイ時に作成された
プレースホルダーのままです。「デプロイ手順」の`put-secret-value`コマンドを実行してください。

## 🧹 クリーンアップ

```sh
npm run destroy:all -w workspaces/lambda-microvms-codex-appserver --project=<project> --env=dev
```

スタックを破棄する前に、RUNNING/SUSPENDED状態のセッションが残っていれば`DELETE /sessions/{id}`で終了させてください
-- `cdk destroy`は`TerminateMicrovm`を自動的には呼び出しません。

## 📚 参考資料

### AWS公式ドキュメント

- [AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)
- [Announcing Lambda MicroVMs (AWS Compute Blog)](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/)

### 関連アーキテクチャ

- [`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/README.ja.md) -- このコントロールプレーンのルーティングが踏襲した、API Gateway + Lambdaパターン。

## 📄 ライセンス

このプロジェクトはApache License, Version 2.0の下でライセンスされています -- 詳細は[LICENSE](../../../LICENSE)ファイルを参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します！詳細は[コントリビューションガイド](../../../docs/contribution/CONTRIBUTING.md)を参照してください。
