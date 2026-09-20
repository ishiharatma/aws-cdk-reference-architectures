# Lambda MicroVMsで実現するServerlessなCodex App Server - AWS CDK Reference Architecture

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **出典。** このリファレンス実装は
> [「Lambda MicroVMsで実現するServerlessなCodex App Server」](https://note.com/japan_d2/n/n618cb3439486)
> (Japan Digital Design, Inc. / 外山智士氏、2026年9月15日)で紹介されたアーキテクチャを、AWS CDKのリファレンス
> アーキテクチャとして実装したものです。元記事は出力配信にポーリングを採用しており、実装をシンプルにするための
> 選択でSSE/WebSocketの方が体験は良いと述べています。本実装では元記事から一歩進めて、ポーリングに加えて
> WebSocketによるpush配信経路を追加しています(詳細は「設計判断」#2)。記事本文がAPIレベルまで詳述していない
> その他2箇所は、AWS Lambda MicroVMsの公開API仕様(`@aws-sdk/client-lambda-microvms`、
> `AWS::Lambda::MicrovmImage`/`AWS::Lambda::NetworkConnector`のCloudFormationスキーマ)から独自に補完しており、
> 該当箇所には以下で個別に注記しています: Lambda MicroVMsがビルド/実行ロールをAssumeする際のIAMサービス
> プリンシパル、および`codex app-server`の正確なstdio JSON-RPCフレーミング/メソッド名。本番利用前には、
> AWS Lambda MicroVMs Developer Guideと[Codex CLIのソースコード](https://github.com/openai/codex)の両方で
> 必ず確認してください。

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

セッション**コントロールプレーン**(7つのLambda関数を持つHTTP API、さらに3つのLambda関数を持つWebSocket API)が、
オンデマンドで起動する**データプレーン**セッションのライフサイクルを仲介します。各セッションは、
[`codex app-server`](https://github.com/openai/codex)(OpenAI Codex CLIのJSON-RPCエージェントプロトコル。
Thread/Turn/Item)を実行するVM分離された[AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/)
です。本実装作成時点で、Lambda MicroVMsには起動したMicroVMにログインしてコマンドを実行し、そのレスポンスを
呼び出し元にストリームで返す機能がありません。そこで本実装では、記事のアプローチに従い、各MicroVM自身が
**独自のHTTPサーバー**(`src/microvm-image/server/`)を実行してその役割を担います。このサーバーはプラット
フォームからのライフサイクルフック呼び出しに応答し、クライアントからのJSON-RPCリクエストを自身が管理する
`codex app-server`の子プロセスへ中継し、MicroVM内の**Event Handler**が`codex app-server`が出力する全行を
DynamoDBの**EventsTable**へ永続化します。これにより、MicroVMがSuspendあるいは終了した後でも、セッションの
Thread内容を読み取り続けられます。`EventsTable`への書き込みは、**DynamoDB Streams**経由で**WebSocket API**に
接続中のクライアントにもほぼリアルタイムでファンアウトされるため、出力を読むためにポーリングが必須ではなく
なります。コントロールプレーン自体はapp-serverへの*入力*トラフィックを一切プロキシせず、セッションのライフ
サイクルと出力配信のみを仲介します。

```
クライアント (Web UI / IDE / CLI)                                    ── コントロールプレーン (HTTP) ──
   │  1. POST /sessions (Cognito JWT)
   ▼
API Gateway HTTP API ── JWT Authorizer (Cognito User Pool)
   │
   ▼
コントロールプレーン Lambda: create / get / delete / suspend / resume / get-events
   │  RunMicrovm / GetMicrovm / SuspendMicrovm / ResumeMicrovm /
   │  TerminateMicrovm / CreateMicrovmAuthToken                      ── データプレーン ──
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
   │  3a. WS接続 wss://.../{stage}?sessionId=...&token=...      ── コントロールプレーン (WebSocket) ──
   ▼                                                ┌── DynamoDB Streams (NEW_IMAGE) ──┐
API Gateway WebSocket API                           │                                   ▼
   │ $connect (Lambda authorizerがCognito IDトークンを検証)   EventsTable ──────▶ forward-event Lambda
   ▼                                                                                     │
ws-connect Lambda ──▶ ConnectionsTable (sessionId → connectionId) ◀────────────────────┘
                                                              PostToConnection (新規イベントをpush)
   │  3b. GET /sessions/{id}/events?after=N (WS接続前後に書かれた分を取得)
   ▼                                                                    ── コントロールプレーン (HTTP) ──
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
| 7つのHTTPコントロールプレーンLambda | `create-session`(RunMicrovm + CreateMicrovmAuthToken)、`get-session`(GetMicrovm)、`delete-session`(TerminateMicrovm)、`suspend-session`(SuspendMicrovm)、`resume-session`(ResumeMicrovm + 新しい認証トークン発行)、`get-events`(`EventsTable`をポーリング)。 |
| 3つのWebSocket Lambda | `ws-authorizer`(`$connect`でCognito IDトークンを検証)、`ws-connect`(接続をセッションに登録)、`ws-disconnect`(登録解除)、`forward-event`(DynamoDB Streamsトリガー、新規`EventsTable`アイテムを接続中クライアントへpush)。 |
| DynamoDB `SessionsTable` | セッション1件につき1アイテム(`sessionId`, `ownerId`, `microvmId`, `endpoint`, `state`)。TTLで自動失効。 |
| DynamoDB `EventsTable` | `codex app-server`の出力1行につき1アイテム(`sessionId`, `sequence`, `event`)。MicroVM内Event Handlerが書き込み。Streams(`NEW_IMAGE`)が`forward-event`をトリガーし、`get-events`が直接読み取る。MicroVM自体のライフサイクルとは独立して残り続ける。 |
| DynamoDB `ConnectionsTable` | どのWebSocket接続がどのセッションを見ているか(`sessionId`, `connectionId`, `ownerId`)。`ws-disconnect`が接続からセッションを逆引きできるよう`ByConnectionId`のGSIを持つ。 |
| Cognito User Pool | HTTP APIのJWT AuthorizerとWebSocket APIのLambda Authorizerの両方を支える。`ownerId`/`sub`がセッション・イベント・接続のすべてのレコードを作成者にスコープする。 |

### Threadの作成、Turnの実行、出力の配信

元記事のシーケンスにpush経路を加えたものです。

1. **セッションを開始する** -- `POST /sessions`(コントロールプレーン)が事前構築済みイメージからMicroVMを起動し
   (`RunMicrovm`)、`runHookPayload: {"sessionId": "..."}`をイメージの`/run`フックのリクエストボディとして渡します。
   これにより、MicroVM内のEvent Handlerが、どの`EventsTable`パーティションに書き込むべきかを把握します。
   レスポンスにはMicroVM自身の`endpoint`と、短命の`X-aws-proxy-auth`トークンが含まれます。
2. **Turnを実行する** -- クライアントはJSON-RPC 2.0リクエストを`{endpoint}/rpc`に直接POSTします(認証ヘッダー付き)。
   MicroVM内サーバーがそれを`codex app-server`のstdinへ中継し、`id`を含むリクエストについては対応するstdout
   レスポンスを同期的に返します。レスポンス・サーバー起点の通知を問わず、すべての行はEvent Handlerによっても
   捕捉されます。
3. **出力を受け取る** -- MicroVMを直接読みに行くのではなく:
   - **Push(ほぼリアルタイム)**: クライアントは`wss://.../{stage}?sessionId=...&token=<Cognito IDトークン>`
     でWebSocket接続を開きます。`ws-authorizer`がトークンを検証し、`ws-connect`が接続を`ConnectionsTable`に
     登録すると、以後そのセッションへの`EventsTable`書き込みは書き込まれた瞬間に`forward-event`(DynamoDB
     Streams + `PostToConnection`経由)によってpushされます。
   - **Pull(取りこぼし取得とフォールバック)**: `GET /sessions/{sessionId}/events?after={sequence}`
     (コントロールプレーン)が`EventsTable`を直接読みます。クライアントはWebSocket接続直後に一度これを呼び
     (接続登録の直前に書き込まれた分を拾うため)、WebSocket接続を維持したくない場合は完全にこちらのポーリング
     だけにフォールバックできます。どちらの経路も`EventsTable`のみを読むため、MicroVMがRUNNING・SUSPENDED・
     終了済みのいずれの状態でも動作します。

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

### 2. 出力配信はpush(WebSocket)方式で、pull(ポーリング)を真実の源泉として維持する

元記事のデモは、実装をシンプルにするためポーリングのみを採用していました。本実装は`EventsTable`を唯一の
真実の源泉として維持しつつ(クライアントは常に`get-events`をポーリングすれば正しい答えを得られる)、その上に
push経路を追加しています: DynamoDB Streamsトリガー(`forward-event`)が、新規アイテムが書き込まれるたびに
接続中のWebSocketクライアントへ配信します。これは置き換えではなく追加です -- WebSocket接続を一度も開かない
クライアントは純粋なポーリングだけで引き続き動作しますし、開くクライアントも、セッション開始からWebSocket
登録までの間隙をカバーするため接続後に一度はポーリングすべきです。

### 3. WebSocketの接続状態はMicroVMのライフサイクルから分離されている

`ConnectionsTable`はMicroVM自身のRUNNING/SUSPENDED状態とは完全に独立して*クライアント*の接続を追跡します。
クライアントのWebSocketセッションは、MicroVMがサスペンド・レジュームされる間も開いたままにでき(次のイベントが
書き込まれるまで単に出力が止まるだけ)、逆にWebSocketを閉じてもMicroVMには一切影響しません。

### 4. Cognito IDトークンはWebSocketハンドシェイクのAuthorizationヘッダーに乗せられない

ブラウザはアプリケーションコードがWebSocketハンドシェイクにカスタムヘッダーを設定することを許可しないため、
IDトークンは代わりに`token`クエリパラメータとして送り、
[`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify)を使う`WebSocketLambdaAuthorizer`
(`ws-authorizer.ts`)で検証します。これはHTTP APIのマネージド`HttpUserPoolAuthorizer`とは異なる点で、
WebSocket APIはこのマネージドオーソライザーを利用できません。

### 5. コントロールプレーンはapp-serverへの*入力*トラフィックを一切プロキシしない

`create-session`と`resume-session`は、MicroVM自身の`endpoint`と、単一ポートにスコープされた短命の
`X-aws-proxy-auth`トークン(`CreateMicrovmAuthToken`の`allowedPorts`で発行)を返します。クライアントはこの
エンドポイントに直接JSON-RPCリクエストを送信します。これにより、コントロールプレーンLambdaのレイテンシと
コストがTurnのトラフィック量から独立します。コントロールプレーンを経由するのは、(はるかに小さい)出力配信
経路のみです。

### 6. `/rpc`は型付きThread/Turn REST APIではなく汎用リレー

MicroVM内サーバーの`/rpc`エンドポイントは、固定の`/threads`/`/turns`REST ルートにメソッド名をハードコード
するのではなく、生のJSON-RPC 2.0リクエストボディをそのまま`codex app-server`のstdinへ転送します。本実装では
`codex app-server`の正確なメソッド/パラメータスキーマをCodex CLIのソースコードに対して独自に検証できて
いないため、HTTP境界では意図的にプロトコル非依存のままにしています。実際に送信すべき`initialize`/thread/
turn/itemのメソッドについては、[Codex CLIのリポジトリ](https://github.com/openai/codex)を参照してください。

### 7. コスト面ではterminateよりsuspendを優先

`idlePolicy`はアイドル状態のMicroVMを終了させるのではなく自動サスペンドします(課金対象はFirecrackerスナップ
ショットストレージのみ)。`POST /sessions/{id}/suspend`と`/resume`により、セッションが一時的に不要であると
クライアントが分かっている場合(タブを閉じたなど)、アイドルタイムアウトを待たずに即座にその遷移をトリガー
できます。

### 8. OpenAI APIキーはイメージにもIaCにも一切含まれない

`CfnMicrovmImage.environmentVariables`には`OPENAI_API_KEY_SECRET_ARN`(全セッション共通の固定値)のみが含まれ
ます。`server/secret.mjs`が、コンテナ起動時に、MicroVMの`executionRoleArn`にプラットフォームが注入する認証
情報を使ってSecrets Managerから実際のシークレット値を取得します。

### 9. セッション・イベント・接続はエンドツーエンドで所有者にスコープされる

CognitoのSubject(`sub`)が`SessionsTable`と`ConnectionsTable`の各アイテムの`ownerId`になります。HTTPルートは
呼び出し者自身のものでないセッションに対して404を返し、WebSocketの`$connect`も同様に拒否します。他ユーザーの
MicroVMエンドポイントや出力を漏洩させません。

## 🏛️ Well-Architectedとの整合性

| 柱 | 本リファレンスでの対応 |
|---|---|
| 運用上の優秀性 | HTTP APIステージのCloudWatchアクセスログ、コントロールプレーンLambdaごと・MicroVMイメージごとの専用CloudWatchロググループ。 |
| セキュリティ | セッションごとのVMレベル分離(Firecracker、カーネル非共有)、全HTTPルートおよびWebSocketの`$connect`ルートでのCognitoベース認可、所有者スコープのセッション/イベント/接続レコード、最小権限のDynamoDB/Secrets Manager権限。 |
| 信頼性 | Turnの出力はDynamoDBに保存されるためMicroVMのSuspend/終了から独立して残り、WebSocket配信は接続が切れてもポーリングへ緩やかにフォールバックする。NAT Gatewayを1台のみとしているのは意図的なコスト/AZ耐性のトレードオフです -- 本番環境ではAZごとにNAT Gatewayを追加してください。 |
| パフォーマンス効率 | MicroVMは事前初期化済みのFirecrackerスナップショット(`codex app-server`とMicroVM内HTTPサーバーが既に起動済み)から再開するためコールドブートせず、出力は固定間隔のポーリングではなくpushでクライアントに届く。 |
| コスト最適化 | `idlePolicy`による自動サスペンド、失効セッション/接続のDynamoDB TTL、全体を通したPAY_PER_REQUEST課金、WebSocket pushによりTurnがアイドルになった後の無駄なポーリングリクエストを回避。 |

## 💰 コスト最適化

本リファレンスは、このリポジトリの他のパターンにはないコスト要素(MicroVMの実行/サスペンド時間、NAT Gateway、
Cognito、WebSocket API)を含みます。**ここに記載する内容を見積もりとして扱わないでください** -- 実際の
ワークロードのコストを見積もる前に、必ずご利用リージョンのAWS料金ページ(Lambda MicroVMs、NAT Gateway、
Cognito、API Gateway WebSocket API、DynamoDB)を確認してください。

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
5. **WebSocket APIの接続分単位料金+メッセージ料金** -- 接続分単位に加えメッセージ単位でも課金されます。
   おしゃべりなTurnにとっては、これは小さなポーリングリクエストの連続を1つの開いた接続+イベント1件あたり
   1メッセージに置き換えるものであり、通常は積極的なポーリングより安価ですが、ポーリング単独には無い
   コスト要素です。`forward-event`のDynamoDB Streams起動は通常のLambda呼び出しとして課金されます。
6. **API Gateway HTTP API + コントロールプレーンLambda** -- 上記に比べれば無視できる程度です。コントロール
   プレーンはセッションライフサイクルと出力配信の呼び出しのみを仲介し、Turnの入力トラフィックは扱いません。
7. **DynamoDB** -- PAY_PER_REQUESTと短いTTLにより、典型的なセッション量ではほぼゼロに近いコストに抑えられます。
   おしゃべりなTurnは`codex app-server`の出力1行につき`EventsTable`へ1アイテム書き込むため、非常に高頻度な
   イベントストリームの場合はこのテーブルの書き込みコスト(および対応するStreamsトリガーの`forward-event`
   呼び出し)に注意する価値があります。

### このパターン固有のコストに関する補足

- コストに敏感な環境では`controlPlane.idleTimeoutInMinutes`を短くしてください。アイドルウィンドウを短くすると
  未使用のMicroVMがより早くサスペンドされますが、次のリクエスト時にレジュームのラウンドトリップが発生します。
- `controlPlane.suspendedDurationInMinutes`は、放置されたセッションがプラットフォームによって完全に終了される
  までスナップショットストレージ料金を払い続ける期間の上限です。`sessionRecordTtlInDays`と整合させてください。
- 生きたコーディングエージェントUIのように断続的な更新で十分なクライアントは、WebSocket接続を一切開かず
  `get-events`のポーリングだけで済ませた方が安価な場合があります -- push経路は応答性のためのものであり、
  正しさのために必須ではありません。

## 🔒 セキュリティ考慮事項

### 実装済み

- セッションごとのVMレベル分離(Firecracker MicroVM、セッション間でカーネルを共有しない)。
- 全HTTPコントロールプレーンルートでのCognitoベース認可(`HttpUserPoolAuthorizer`)、およびWebSocket APIの
  `$connect`ルートでの認可(同じユーザープールのIDトークンを検証する`WebSocketLambdaAuthorizer`)。
- 所有者スコープのセッション・イベント・接続レコード(JWTの`ownerId`/`sub`)。
- OpenAI APIキーはSecrets Managerにのみ存在し、イメージに焼き込まれるのはそのARNのみ。
- 最小権限のDynamoDB(`grantReadWriteData`/`grantWriteData`/`grantReadData`をそれぞれ1つのテーブルにスコープ)
  およびSecrets Manager(`grantRead`を対象シークレット1つにスコープ)の権限付与。`forward-event`の
  `execute-api:ManageConnections`権限は1つのWebSocket APIステージにスコープされている。
- MicroVM egress経路用のアウトバウンド専用セキュリティグループ(インバウンドルールなし)。

### 意図的にスコープ外(環境ごとに追加してください)

- HTTP API向けのWAFv2 Web ACL(WAFはWebSocket APIをサポートしません)。
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

# 出力を書き込まれた順に受け取るためWebSocket接続を開く（WebSocketUrlはスタック出力から取得）:
wscat -c "$WEBSOCKET_URL?sessionId=$SESSION_ID&token=$ID_TOKEN"

# MicroVM自身のエンドポイントに直接JSON-RPCリクエストを送信する（実際のinitialize/thread/turnのメソッド名・
# パラメータはCodex CLIのドキュメントを参照）:
curl -X POST "$ENDPOINT/rpc" -H "X-aws-proxy-auth: $AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# 出力はWebSocket接続に書き込まれた順に届く。接続登録前に書き込まれた分を取得したい場合や、
# そもそもWebSocket接続を維持したくない場合は、代わりにポーリングする:
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

### WebSocket経路を外してポーリングのみにする

ほぼリアルタイムの更新が不要なクライアントは、`GET /sessions/{id}/events`だけを呼び、WebSocket接続を一切
開かなくても構いません -- どちらの経路でも`EventsTable`が真実の源泉であるため、サーバー側の変更は不要です。
WebSocketインフラを完全に削除する場合は、`WebSocketApi`/`WebSocketStage`、`ws-*`/`forward-event`の各Lambda、
`ConnectionsTable`、`EventsTable`の`stream`プロパティを削除してください。

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

### WebSocket接続がコード1008で即座に閉じる(あるいは`$connect`が401/404相当を返す)

- 401相当の拒否: `ws-authorizer`が`token`クエリパラメータを検証できていません -- デプロイしたスタックと
  同じユーザープール/クライアントのCognito**IDトークン**(アクセストークンではない)を渡しているか確認して
  ください。
- 404相当の拒否: `ws-connect`が、そのトークンの`sub`が所有する`sessionId`のセッションを見つけられていません
  -- 同じCognitoユーザーで先に`POST /sessions`を呼んでいるか確認してください。

### WebSocketは接続できるがイベントが一切届かない

`ForwardEventFunctionLogGroup`で`GoneException`やその他の`PostToConnection`エラーを確認してください。何も
ログが出ていない場合は、`EventsTable`のDynamoDB Streamsトリガー(`AWS::Lambda::EventSourceMapping`)が
`Enabled`になっているか、実際にイベントが書き込まれているか(前項参照)を確認してください。

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
- [API Gateway WebSocket APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html)

### Codex

- [OpenAI Codex CLI (`codex app-server`)](https://github.com/openai/codex)

### 関連アーキテクチャ

- [`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/README.ja.md) -- このコントロールプレーンのHTTPルーティングが踏襲した、API Gateway + Lambdaパターン。

## 📄 ライセンス

このプロジェクトはApache License, Version 2.0の下でライセンスされています -- 詳細は[LICENSE](../../../LICENSE)ファイルを参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します！詳細は[コントリビューションガイド](../../../docs/contribution/CONTRIBUTING.md)を参照してください。
