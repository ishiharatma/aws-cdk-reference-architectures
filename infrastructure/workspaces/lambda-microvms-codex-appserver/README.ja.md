# Lambda MicroVMsで実現するServerlessなCodex App Server - AWS CDK Reference Architecture

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **出典。** このリファレンス実装は
> [「Lambda MicroVMsで実現するServerlessなCodex App Server」](https://note.com/japan_d2/n/n618cb3439486)
> (Japan Digital Design, Inc. / 外山智士氏、2026年9月15日)で紹介されたアーキテクチャを、AWS CDKのリファレンス
> アーキテクチャとして実装したものです。記事本文がAPIレベルまで詳述していない箇所は、AWS Lambda MicroVMsの
> 公開API仕様(`@aws-sdk/client-lambda-microvms`、`AWS::Lambda::MicrovmImage`/`AWS::Lambda::NetworkConnector`の
> CloudFormationスキーマ)から独自に補完しており、該当箇所には以下で個別に注記しています: Lambda MicroVMsが
> ビルド/実行ロールをAssumeする際のIAMサービスプリンシパル、および`codex app-server`の正確なstdio JSON-RPC
> フレーミング/メソッド名。本番利用前には、AWS Lambda MicroVMs Developer Guideと
> [Codex CLIのソースコード](https://github.com/openai/codex)の両方で必ず確認してください。

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

セッション**コントロールプレーン**(API Gateway HTTP API + 6つのLambda関数)が、オンデマンドで起動する**データプレーン**
セッションのライフサイクルを仲介します。各セッションは、[`codex app-server`](https://github.com/openai/codex)
(OpenAI Codex CLIのJSON-RPCエージェントプロトコル。Thread/Turn/Item)を実行するVM分離された
[AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/)です。本実装作成時点で、Lambda MicroVMsには
起動したMicroVMにログインしてコマンドを実行し、そのレスポンスを呼び出し元にストリームで返す機能がありません。
そこで本実装では、記事のアプローチに従い、各MicroVM自身が**独自のHTTPサーバー**(`src/microvm-image/server/`)を
実行してその役割を担います。このサーバーはプラットフォームからのライフサイクルフック呼び出しに応答し、
クライアントからのJSON-RPCリクエストを自身が管理する`codex app-server`の子プロセスへ中継し、MicroVM内の
**Event Handler**が`codex app-server`が出力する全行をDynamoDBの**EventsTable**へ永続化します。これにより、
MicroVMがSuspendあるいは終了した後でも、セッションのThread内容を読み取り続けられます。コントロールプレーン
自体はapp-serverのトラフィックを一切プロキシせず、セッションのライフサイクル(開始/状態取得/サスペンド/
レジューム/終了/出力ポーリング)のみを仲介します。

```
クライアント (Web UI / IDE / CLI)
   │  1. POST /sessions (Cognito JWT)                        ── コントロールプレーン ──
   ▼
API Gateway HTTP API ── JWT Authorizer (Cognito User Pool)
   │
   ▼
コントロールプレーン Lambda: create / get / delete / suspend / resume / get-events
   │  RunMicrovm / GetMicrovm / SuspendMicrovm / ResumeMicrovm /
   │  TerminateMicrovm / CreateMicrovmAuthToken              ── データプレーン ──
   ▼
Lambda MicroVMs データプレーン
   │  codex app-serverイメージからFirecracker MicroVMを起動
   │  POST /run (RunMicrovmRequest.runHookPayload = {sessionId}) で初期化
   ▼
MicroVM (VM分離、専用HTTPSエンドポイント)
   MicroVM内HTTPサーバー (server/index.mjs)
     ├─ ライフサイクルフック: GET /ready・POST /run,/suspend,/resume,/terminate
     ├─ /rpc  ──stdio JSON-RPC──▶  codex app-server (子プロセス)
     └─ Event Handler  ─────────────▶  DynamoDB EventsTable (出力の全行)
   ── AWS::Lambda::NetworkConnector経由でegress → NAT Gateway → OpenAI API

   │  2. POST {endpoint}/rpc + X-aws-proxy-auth、MicroVMエンドポイントに直接接続
   ▼
クライアント
   │  3. GET /sessions/{id}/events?after=N (Turn終了までポーリング)   ── コントロールプレーン ──
   ▼
API Gateway → get-events Lambda ──▶ DynamoDB EventsTable (読み取り専用、MicroVM状態非依存)
```

### 主要コンポーネント

| コンポーネント | 役割 |
|---|---|
| `AWS::Lambda::MicrovmImage` (`CfnMicrovmImage`) | `src/microvm-image/`(Node.js + `@openai/codex` + MicroVM内HTTPサーバー)をスナップショット済みMicroVMイメージにパッケージ化。 |
| `AWS::Lambda::NetworkConnector` + VPC (NAT Gateway 1台) | MicroVMの`egressNetworkConnectors`がインターネット(OpenAI API)に到達できる唯一の手段。これがないと`codex app-server`はアウトバウンド通信を一切できません。 |
| **MicroVM内HTTPサーバー** (`server/index.mjs`) | プラットフォームのライフサイクルフックにHTTPで応答(`GET /ready`, `POST /run`/`/suspend`/`/resume`/`/terminate`)し、`POST /rpc`リクエストを自身がspawn・管理する`codex app-server`子プロセス(`server/codex-process.mjs`)へ中継。 |
| **Event Handler** (`server/event-handler.mjs`) | `codex app-server`がstdoutに書き込む全行を購読し、セッションごとに連番を振って`EventsTable`へ永続化。 |
| Secrets Managerシークレット | OpenAI APIキーを保持。イメージに焼き込まれるのはそのARN(`OPENAI_API_KEY_SECRET_ARN`)のみで、値自体はコンテナ起動時に実行ロールを使ってMicroVM内サーバー(`server/secret.mjs`)が取得します。 |
| 6つのコントロールプレーンLambda | `create-session`(RunMicrovm + CreateMicrovmAuthToken)、`get-session`(GetMicrovm)、`delete-session`(TerminateMicrovm)、`suspend-session`(SuspendMicrovm)、`resume-session`(ResumeMicrovm + 新しい認証トークン発行)、**`get-events`**(`EventsTable`をポーリング)。 |
| DynamoDB `SessionsTable` | セッション1件につき1アイテム(`sessionId`, `ownerId`, `microvmId`, `endpoint`, `state`)。TTLで自動失効。 |
| DynamoDB `EventsTable` | `codex app-server`の出力1行につき1アイテム(`sessionId`, `sequence`, `event`)。MicroVM内Event Handlerが書き込み、`get-events`が読み取る。MicroVM自体のライフサイクルとは独立して残り続ける。 |
| Cognito User Pool + HTTP API JWT Authorizer | すべてのコントロールプレーンルートが有効なCognito JWTを要求。`ownerId`によりセッションの読み書きを作成者本人にスコープします。 |

### Threadの作成、Turnの実行、出力の取得

元記事のシーケンスに沿った流れです。

1. **セッションを開始する** -- `POST /sessions`(コントロールプレーン)が事前構築済みイメージからMicroVMを起動し
   (`RunMicrovm`)、`runHookPayload: {"sessionId": "..."}`をイメージの`/run`フックのリクエストボディとして渡します。
   これにより、MicroVM内のEvent Handlerが、どの`EventsTable`パーティションに書き込むべきかを把握します。
   レスポンスにはMicroVM自身の`endpoint`と、短命の`X-aws-proxy-auth`トークンが含まれます。
2. **Turnを実行する** -- クライアントはJSON-RPC 2.0リクエストを`{endpoint}/rpc`に直接POSTします(認証ヘッダー付き)。
   MicroVM内サーバーがそれを`codex app-server`のstdinへ中継し、`id`を含むリクエストについては対応するstdout
   レスポンスを同期的に返します。レスポンス・サーバー起点の通知を問わず、すべての行はEvent Handlerによっても
   捕捉されます。
3. **出力を取得する** -- クライアントはMicroVMを直接読みに行くのではなく、Turnが完了するまで
   `GET /sessions/{sessionId}/events?after={sequence}`(コントロールプレーン)をポーリングします。このLambdaは
   `EventsTable`のみを読むため、MicroVMがRUNNING・SUSPENDED・終了済みのいずれの状態でも動作し続けます。
   (元記事では、SSEやWebSocketの方がより良い体験になるがポーリングの方が実装がシンプルだと述べられており、
   本実装もこれに倣ってポーリング方式を採用しています。)

### MicroVMライフサイクルフック

`cdk synth`のCloudFormation Validateプラグインにより、`AWS::Lambda::MicrovmImage`の`Hooks.MicrovmHooks.*`
および`Hooks.MicrovmImageHooks.*`は、スクリプトパスの文字列ではなく`ENABLED`/`DISABLED`のスイッチであることが
確認されています。元記事の内容に基づくと、フックを有効化すると、プラットフォームはそれを**コンテナの`Hooks.port`
に対するHTTPリクエスト**として呼び出します。

| フック | HTTP呼び出し | タイミング | MicroVM内サーバーの処理 |
|---|---|---|---|
| `ready` (イメージビルド時) | `GET /ready` | Dockerfileのコンテナ起動後、Firecrackerスナップショット取得前にポーリング | `codex app-server`のspawnとEvent Handlerの配線が完了した時点で200を返す。 |
| `validate` (イメージビルド時) | `GET /validate` | スナップショット取得後に一度ポーリング | `ready`と同じチェック。スナップショット自体が正常に再開できる状態であることを確認。 |
| `run` | `POST /run` | MicroVM PENDING → RUNNING | `runHookPayload`の`sessionId`を読み取り、Event Handlerに紐付ける。`codex app-server`とHTTPサーバーはスナップショットから既に再開済みのため、この処理は軽量。 |
| `suspend` / `resume` | `POST /suspend` / `POST /resume` | RUNNING ⇄ SUSPENDED | ログ出力のみ。プロセス状態(実行中のThread/Turn/Item含む)はFirecracker自身のメモリ+ディスクスナップショットが自動的に保持する。 |
| `terminate` | `POST /terminate` | MicroVM破棄直前 | `codex app-server`のベストエフォートなグレースフルシャットダウン。 |

## 🎯 設計判断とベストプラクティス

### 1. MicroVM内HTTPサーバーが「実行してストリームで受ける」機能の欠如を補う

Lambda MicroVMsには、実行中のMicroVMにログインしてコマンドの出力をストリームで受け取るAPIがありません。
本実装は元記事のアプローチに従い、イメージ自体がHTTPサーバーを実行して`codex app-server`へJSON-RPCを中継し、
その出力を捕捉することで、外部の呼び出し元は通常のHTTPSだけで済むようにしています。

### 2. Turnの出力はMicroVMのライフサイクルから独立して永続化される

Event Handlerは`codex app-server`の各行を発生の都度DynamoDBに書き込みます。`get-events`はこのテーブルのみを
読み、MicroVMを直接読みには行きません。そのため、コストを抑えるためにセッションをサスペンドした後や、
終了した後でも、クライアントはTurnの出力を読み続けられます。これは元記事がこの設計を採用した理由と一致します。

### 3. コントロールプレーンはapp-serverへの*入力*トラフィックを一切プロキシしない

`create-session`と`resume-session`は、MicroVM自身の`endpoint`と、単一ポートにスコープされた短命の
`X-aws-proxy-auth`トークン(`CreateMicrovmAuthToken`の`allowedPorts`で発行)を返します。クライアントはこの
エンドポイントに直接JSON-RPCリクエストを送信します。これにより、コントロールプレーンLambdaのレイテンシと
コストがTurnのトラフィック量から独立します。コントロールプレーンを経由するのは、(はるかに小さい)出力
ポーリングの読み取りのみです。

### 4. `/rpc`は型付きThread/Turn REST APIではなく汎用リレー

MicroVM内サーバーの`/rpc`エンドポイントは、固定の`/threads`/`/turns`REST ルートにメソッド名をハードコード
するのではなく、生のJSON-RPC 2.0リクエストボディをそのまま`codex app-server`のstdinへ転送します。本実装では
`codex app-server`の正確なメソッド/パラメータスキーマをCodex CLIのソースコードに対して独自に検証できて
いないため、HTTP境界では意図的にプロトコル非依存のままにしています。実際に送信すべき`initialize`/thread/
turn/itemのメソッドについては、[Codex CLIのリポジトリ](https://github.com/openai/codex)を参照してください。

### 5. コスト面ではterminateよりsuspendを優先

`idlePolicy`はアイドル状態のMicroVMを終了させるのではなく自動サスペンドします(課金対象はFirecrackerスナップ
ショットストレージのみ)。`POST /sessions/{id}/suspend`と`/resume`により、セッションが一時的に不要であると
クライアントが分かっている場合(タブを閉じたなど)、アイドルタイムアウトを待たずに即座にその遷移をトリガー
できます。

### 6. OpenAI APIキーはイメージにもIaCにも一切含まれない

`CfnMicrovmImage.environmentVariables`には`OPENAI_API_KEY_SECRET_ARN`(全セッション共通の固定値)のみが含まれ
ます。`server/secret.mjs`が、コンテナ起動時に、MicroVMの`executionRoleArn`にプラットフォームが注入する認証
情報を使ってSecrets Managerから実際のシークレット値を取得します。

### 7. セッションはエンドツーエンドで所有者にスコープされる

Cognito JWTの`sub`クレームが`SessionsTable`の各アイテムの`ownerId`になります。`get/delete/suspend/resume/
get-events`はいずれも、呼び出し者自身のセッションでない場合は404を返し、他ユーザーのMicroVMエンドポイントや
出力を漏洩させません。

## 🏛️ Well-Architectedとの整合性

| 柱 | 本リファレンスでの対応 |
|---|---|
| 運用上の優秀性 | HTTP APIステージのCloudWatchアクセスログ、コントロールプレーンLambdaごと・MicroVMイメージごとの専用CloudWatchロググループ。 |
| セキュリティ | セッションごとのVMレベル分離(Firecracker、カーネル非共有)、全ルートでのCognito JWT認可、所有者スコープのセッション/イベントレコード、最小権限のDynamoDB/Secrets Manager権限。 |
| 信頼性 | Turnの出力はDynamoDBに保存されるためMicroVMのSuspend/終了から独立して残る。NAT Gatewayを1台のみとしているのは意図的なコスト/AZ耐性のトレードオフです -- 本番環境ではAZごとにNAT Gatewayを追加してください。 |
| パフォーマンス効率 | MicroVMは事前初期化済みのFirecrackerスナップショット(`codex app-server`とMicroVM内HTTPサーバーが既に起動済み)から再開するためコールドブートしません。 |
| コスト最適化 | `idlePolicy`による自動サスペンド、失効セッションのDynamoDB TTL、全体を通したPAY_PER_REQUEST課金。 |

## 💰 コスト最適化

本リファレンスは、このリポジトリの他のパターンにはないコスト要素(MicroVMの実行/サスペンド時間、NAT Gateway、
Cognito)を含みます。**ここに記載する内容を見積もりとして扱わないでください** -- 実際のワークロードのコストを
見積もる前に、必ずご利用リージョンのAWS料金ページ(Lambda MicroVMs、NAT Gateway、Cognito、DynamoDB)を確認して
ください。

このアーキテクチャで重要度が高い順に、おおまかなコスト*要因*を挙げます。

1. **MicroVMのRUNNING時間** -- セッションのMicroVMが稼働中の間課金されます(稼働中のCodexセッションにおける
   主要因)。
2. **MicroVMのSUSPENDED時間** -- Firecrackerスナップショットのストレージのみが課金対象です。これが、レイテンシ
   だけでなくコストの観点からも`idlePolicy`と明示的な`/suspend`ルートが重要である理由です。Turnの出力は
   `EventsTable`に保存されているため、積極的にサスペンドしても出力の可用性は失われません。
3. **NAT Gateway** -- 時間単位の課金に加え、`codex app-server`がOpenAI APIとの間で送受信する全バイトに対する
   データ処理料金がかかります。NAT Gatewayを1台のみとする構成(本リファレンスのデフォルト)が最も安価な構成です。
   インターネットegress以外にMicroVMが必要とするAWSサービス通信があれば、VPCエンドポイントの利用を検討してください。
4. **Cognito** -- MAU課金が始まるまで無料利用枠が一定数のMAUをカバーします。Plus機能プラン(`AwsSolutions-COG8`、
   本実装ではサプレッション済み)を有効化すると、さらにMAU単位の追加コストが発生します。
5. **API Gateway HTTP API + コントロールプレーンLambda** -- 上記に比べれば無視できる程度です。コントロール
   プレーンはセッションライフサイクルとイベントポーリングの呼び出しのみを仲介し、Turnの入力トラフィックは
   扱いません。
6. **DynamoDB** -- PAY_PER_REQUESTと短いTTLにより、典型的なセッション量ではほぼゼロに近いコストに抑えられます。
   おしゃべりなTurnは`codex app-server`の出力1行につき`EventsTable`へ1アイテム書き込むため、非常に高頻度な
   イベントストリームの場合はこのテーブルの書き込みコストに注意する価値があります。

### このパターン固有のコストに関する補足

- コストに敏感な環境では`controlPlane.idleTimeoutInMinutes`を短くしてください。アイドルウィンドウを短くすると
  未使用のMicroVMがより早くサスペンドされますが、次のリクエスト時にレジュームのラウンドトリップが発生します。
- `controlPlane.suspendedDurationInMinutes`は、放置されたセッションがプラットフォームによって完全に終了される
  までスナップショットストレージ料金を払い続ける期間の上限です。`sessionRecordTtlInDays`と整合させてください。

## 🔒 セキュリティ考慮事項

### 実装済み

- セッションごとのVMレベル分離(Firecracker MicroVM、セッション間でカーネルを共有しない)。
- 全コントロールプレーンルートでのCognito JWT認可(`HttpUserPoolAuthorizer`)。
- 所有者スコープのセッション・イベントレコード(JWTの`sub`クレームに由来する`ownerId`)。
- OpenAI APIキーはSecrets Managerにのみ存在し、イメージに焼き込まれるのはそのARNのみ。
- 最小権限のDynamoDB(`grantReadWriteData`/`grantWriteData`/`grantReadData`をそれぞれ1つのテーブルにスコープ)
  およびSecrets Manager(`grantRead`を対象シークレット1つにスコープ)の権限付与。
- MicroVM egress経路用のアウトバウンド専用セキュリティグループ(インバウンドルールなし)。

### 意図的にスコープ外(環境ごとに追加してください)

- HTTP API向けのWAFv2 Web ACL。
- Lambdaハンドラ自身が行う以上のリクエストボディ/スキーマバリデーション。
- CognitoのMFAおよびPlus機能プラン(高度なセキュリティ機能)。
- VPCフローログ。
- Secrets Managerの自動ローテーション(ローテーション用Lambdaを持たないサードパーティAPIキーには適用不可。
  手動でローテーションしてください)。
- MicroVM内サーバーの`/rpc`エンドポイントを、プラットフォーム自身の`X-aws-proxy-auth`ゲートとは別に追加認証
  する仕組み: 有効なMicroVM認証トークンを持つ呼び出し元は誰でも、同じ`Hooks.port`を共有する`/rpc`・`/run`・
  `/suspend`・`/resume`・`/terminate`のいずれにも到達できます。プラットフォーム自身のフック呼び出し経路が
  クライアントトラフィックから別途分離されていない場合は、環境ごとにさらに制限を追加してください。

### 本番利用前に検証すべき2点

1. **IAM信頼ポリシー。** スタック内の`microvmServicePrincipal`は、Lambda MicroVMsがイメージビルドおよび
   MicroVM実行の際にAssumeするプリンシパルとして`lambda.amazonaws.com`を最有力の推測値として使用しています。
   実際に必要なプリンシパル(および`sts:ExternalId`等の条件キー)をAWS Lambda MicroVMs Developer Guideで
   確認してください。
2. **`codex app-server`のJSON-RPCフレーミングとメソッド名。** `server/codex-process.mjs`は改行区切りJSONを
   stdio経由でやり取りすると仮定しており、`/rpc`は特定のメソッド名を前提とせずリクエストをそのまま転送します。
   両方とも[Codex CLIのソースコード](https://github.com/openai/codex)で確認してください。

### CDK Nag

`test/compliance/cdk-nag.test.ts`が`AwsSolutionsChecks`パックを実行し、サプレッションされていない警告/エラー
がゼロであることを検証します。各サプレッションは上記の「意図的にスコープ外」項目のいずれかに紐づく理由を持ち、
加えて`lambda-microvms:*`アクション向けの`AwsSolutions-IAM5`も含みます(これらのリソースARN -- MicroVMおよび
イメージの識別子 -- は`RunMicrovm`実行時に採番されるため、デプロイ前にスコープを絞り込めません)。

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

# MicroVM自身のエンドポイントに直接JSON-RPCリクエストを送信する（実際のinitialize/thread/turnのメソッド名・
# パラメータはCodex CLIのドキュメントを参照）:
curl -X POST "$ENDPOINT/rpc" -H "X-aws-proxy-auth: $AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# Turn完了まで出力をポーリングする:
curl "$API_URL/sessions/$SESSION_ID/events?after=0" -H "Authorization: Bearer $ID_TOKEN"

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

### ポーリングからSSE/WebSocketへの移行

元記事では、実装をシンプルにするためポーリングを採用しつつ、SSEやWebSocketの方がより良い体験になると述べられて
います。移行する場合は、`get-events`のリクエスト/レスポンスモデルを、`EventsTable`を真実の源泉として使い続ける
API Gateway WebSocket API(またはSSE対応のLambdaレスポンスストリーミング構成)に置き換えてください。

### MicroVMデータプレーンのIAMアクションをさらに絞り込む

アカウント内でMicroVM/イメージリソースの安定したARNパターンが分かっている場合は、
`lib/stacks/lambda-microvms-codex-appserver-stack.ts`の`microvmDataPlanePolicy`にある`resources: ['*']`を
そのパターンに置き換え、対応する`AwsSolutions-IAM5`のサプレッションを削除してください。

### AZごとにNAT Gatewayを追加する

`Vpc`コンストラクトの`natGateways: 1`を`natGateways: 2`に変更すると、本番グレードのAZ耐性が得られます(NAT Gateway
のコストはおおむね倍になります)。

## 🔧 トラブルシューティング

### `CfnMicrovmImage`の検証で`cdk deploy`が失敗する

`parameters/dev-params.ts`の`baseImageArn`/`baseImageVersion`を確認してください -- プレースホルダーのままでは
デプロイ時に失敗します。`aws lambda-microvms list-managed-microvm-images`を再実行して現在の値を取得してください。

### `RunMicrovm`は成功するが`POST {endpoint}/rpc`が応答しない

MicroVMのCloudWatchロググループ(`MicrovmImageLogGroup`)で`[server]`/`[codex app-server]`のログ行を確認して
ください。MicroVM内サーバーが「listening」というログを一度も出していない場合、`server/index.mjs`がポートを
バインドする前にコンテナの`ENTRYPOINT`が失敗している可能性があります -- イメージに焼き込まれた`npm install`
が失敗していないか確認してください。

### `GET /sessions/{id}/events`が常に空のリストを返す

`create-session`が`runHookPayload`を送信しているか確認してください。MicroVM内サーバーの`/run`ハンドラが
`sessionId`を一度も受け取っていない場合、Event Handlerは各行を紐付け先不明のまま書き込まずに破棄します
(`server/event-handler.mjs`参照)。

### `codex app-server`は起動するが即座に認証エラーになる

`OPENAI_API_KEY_SECRET_ARN`環境変数が指すSecrets Managerシークレットの値が、初回デプロイ時に作成された
プレースホルダーのままです。「デプロイ手順」の`put-secret-value`コマンドを実行してください。

## 🧹 クリーンアップ

```sh
npm run destroy:all -w workspaces/lambda-microvms-codex-appserver --project=<project> --env=dev
```

スタックを破棄する前に、RUNNING/SUSPENDED状態のセッションが残っていれば`DELETE /sessions/{id}`で終了させて
ください -- `cdk destroy`は`TerminateMicrovm`を自動的には呼び出しません。

## 📚 参考資料

### 元記事

- [Lambda MicroVMsで実現するServerlessなCodex App Server](https://note.com/japan_d2/n/n618cb3439486)(Japan Digital Design, Inc.)

### AWS公式ドキュメント

- [AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)
- [Announcing Lambda MicroVMs (AWS Compute Blog)](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/)

### Codex

- [OpenAI Codex CLI (`codex app-server`)](https://github.com/openai/codex)

### 関連アーキテクチャ

- [`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/README.ja.md) -- このコントロールプレーンのルーティングが踏襲した、API Gateway + Lambdaパターン。

## 📄 ライセンス

このプロジェクトはApache License, Version 2.0の下でライセンスされています -- 詳細は[LICENSE](../../../LICENSE)ファイルを参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します！詳細は[コントリビューションガイド](../../../docs/contribution/CONTRIBUTING.md)を参照してください。
