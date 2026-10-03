# Serverless Codex App Server on AWS Lambda MicroVMs — Cognito認証のコントロールプレーンとVM分離されたセッション単位のデータプレーン

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## はじめに

[AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)の上で、セッションごとに VM 分離された [`codex app-server`](https://github.com/openai/codex) をオンデマンドに起動する、リファレンス実装です。セッションを管理するコントロールプレーンは、7つの Lambda 関数を持つ API Gateway HTTP API と、さらに3つの Lambda 関数を持つ WebSocket API で構成します。Turn の出力は、DynamoDB のイベントテーブルから push(WebSocket)と pull(ポーリング)の両方で届けます。

このアーキテクチャで確認できること:

- 常時稼働の共有ホストを使わず、セッションごとに VM 分離したデータプレーン。サスペンド/レジュームと、アイドル時の自動サスペンドにも対応する
- 「MicroVM にログインしてコマンドを実行し、出力をストリームで受け取る」手段がない問題を、MicroVM 内の HTTP サーバーで解決する。呼び出し側は通常の HTTPS だけで済む
- 出力の置き場を `EventsTable` に一本化し、その上に DynamoDB Streams による WebSocket push を重ねる。ポーリングは常に使えるフォールバックとして残す
- すべての HTTP ルートと WebSocket の `$connect` で、Cognito 認証と所有者単位のアクセス制御を行う
- OpenAI API キーは Secrets Manager にだけ置き、イメージにも IaC にも入れない
- 2026-09-27 に実機でエンドツーエンドのデプロイ検証を実施。見つかって直した6件の不具合は[実機デプロイ検証](#-実機デプロイ検証)にまとめている

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [使い方](#使い方)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [実機デプロイ検証](#-実機デプロイ検証)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Overview](overview.drawio.svg)

セッションの**コントロールプレーン**(7つの Lambda 関数を持つ HTTP API と、3つの Lambda 関数を持つ WebSocket API)が、オンデマンドで起動する**データプレーン**のセッションを管理します。1セッションは、VM 分離された [AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/) 1台で、中では [`codex app-server`](https://github.com/openai/codex)(OpenAI Codex CLI の JSON-RPC エージェントプロトコル。Thread/Turn/Item を扱う)が動いています。

この実装を作った時点の Lambda MicroVMs には、起動中の MicroVM にログインしてコマンドを実行し、その応答をストリームで呼び出し元へ返す手段がありません。そこで各 MicroVM に**専用の HTTP サーバー**(`src/microvm-image/server/`)を持たせ、次の3つを担当させています。

- プラットフォームが呼び出すライフサイクルフックへの応答
- クライアントから届いた JSON-RPC リクエストを、自分が管理する `codex app-server` の子プロセスへ中継すること
- MicroVM 内の **Event Handler** による、`codex app-server` が出力する全行の DynamoDB **EventsTable** への保存

出力は DynamoDB に残るので、MicroVM がサスペンドや終了をしたあとでも、セッションの Thread は読み続けられます。`EventsTable` への書き込みは **DynamoDB Streams** を経由して、**WebSocket API** に接続中のクライアントへほぼリアルタイムに届きます。そのため、出力を受け取るのにポーリングは必須ではありません。コントロールプレーンが担当するのはセッションのライフサイクルと出力の配信だけで、app-server への*入力*はプロキシしません。

```text
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
| `AWS::Lambda::MicrovmImage` (`CfnMicrovmImage`) | `src/microvm-image/`(Node.js、`@openai/codex`、MicroVM 内 HTTP サーバー)を、スナップショット済みの MicroVM イメージにまとめる。 |
| `AWS::Lambda::NetworkConnector` と VPC(NAT Gateway 1台) | MicroVM の `egressNetworkConnectors` からインターネット(OpenAI API)へ出るための唯一の経路。これがないと `codex app-server` は外へ一切通信できない。 |
| **MicroVM 内 HTTP サーバー**(`server/index.mjs`) | プラットフォームのライフサイクルフック(`GET /ready`、`POST /run`・`/suspend`・`/resume`・`/terminate`)に応答し、`POST /rpc` を、自分が起動・管理する `codex app-server` の子プロセス(`server/codex-process.mjs`)へ中継する。 |
| **Event Handler**(`server/event-handler.mjs`) | `codex app-server` が stdout に書く全行を受け取り、セッションごとの連番を付けて `EventsTable` に保存する。 |
| Secrets Manager のシークレット | OpenAI API キーを保持する。イメージに入るのは ARN(`OPENAI_API_KEY_SECRET_ARN`)だけで、値はコンテナ起動時に、MicroVM 内サーバー(`server/secret.mjs`)が実行ロールの権限で取得する。 |
| HTTP のコントロールプレーン Lambda 7つ | `create-session`(RunMicrovm と CreateMicrovmAuthToken)、`get-session`(GetMicrovm)、`delete-session`(TerminateMicrovm)、`suspend-session`(SuspendMicrovm)、`resume-session`(ResumeMicrovm と新しい認証トークンの発行)、`get-events`(`EventsTable` を読む)。 |
| WebSocket 用 Lambda 3つ | `ws-authorizer`(`$connect` で Cognito の ID トークンを検証)、`ws-connect`(接続をセッションに登録)、`ws-disconnect`(登録を解除)。さらに DynamoDB Streams から起動する `forward-event` が、新しい `EventsTable` のアイテムを接続中のクライアントへ push する。 |
| DynamoDB `SessionsTable` | セッション1件につき1アイテム(`sessionId`、`ownerId`、`microvmId`、`endpoint`、`state`)。TTL で自動的に失効する。 |
| DynamoDB `EventsTable` | `codex app-server` の出力1行につき1アイテム(`sessionId`、`sequence`、`event`)。MicroVM 内の Event Handler が書き込む。Streams(`NEW_IMAGE`)が `forward-event` を起動し、`get-events` は直接読む。MicroVM のライフサイクルとは無関係に残る。 |
| DynamoDB `ConnectionsTable` | どの WebSocket 接続がどのセッションを見ているか(`sessionId`、`connectionId`、`ownerId`)。`ws-disconnect` が接続からセッションを引けるよう、`ByConnectionId` の GSI を持つ。 |
| Cognito User Pool | HTTP API の JWT Authorizer と、WebSocket API の Lambda Authorizer の両方で使う。`ownerId`(`sub`)により、セッション・イベント・接続のレコードは作成者だけが扱える。 |

### Thread の作成、Turn の実行、出力の配信

push の経路を含めた流れは次のとおりです。

1. **セッションを開始する。** `POST /sessions`(コントロールプレーン)が、構築済みのイメージから MicroVM を起動します(`RunMicrovm`)。このとき `runHookPayload: {"sessionId": "..."}` をイメージの `/run` フックのリクエストボディとして渡すので、MicroVM 内の Event Handler は、どの `EventsTable` のパーティションに書くべきかを把握できます。レスポンスには、MicroVM 自身の `endpoint` と、有効期間の短い `X-aws-proxy-auth` トークンが入っています。
2. **Turn を実行する。** クライアントは JSON-RPC 2.0 のリクエストを `{endpoint}/rpc` へ直接 POST します(認証ヘッダー付き)。MicroVM 内のサーバーがこれを `codex app-server` の stdin へ中継し、`id` を持つリクエストには、対応する stdout の応答をそのまま同期で返します。応答かサーバーからの通知かを問わず、すべての行を Event Handler も受け取ります。
3. **出力を受け取る。** MicroVM を直接読みに行くことはしません。
   - **push(ほぼリアルタイム)**: クライアントは `wss://.../{stage}?sessionId=...&token=<Cognito ID トークン>` で WebSocket に接続します。`ws-authorizer` がトークンを検証し、`ws-connect` が接続を `ConnectionsTable` に登録します。以降、そのセッションの `EventsTable` に書かれたイベントは、書かれた直後に `forward-event`(DynamoDB Streams と `PostToConnection`)から届きます。
   - **pull(取りこぼしの回収とフォールバック)**: `GET /sessions/{sessionId}/events?after={sequence}`(コントロールプレーン)が `EventsTable` を直接読みます。接続の登録直前に書かれた分を拾うため、WebSocket に接続した直後に一度呼んでください。WebSocket を維持したくないクライアントは、この API のポーリングだけでも使えます。どちらの経路も `EventsTable` だけを読むので、MicroVM が RUNNING でも SUSPENDED でも終了済みでも動きます。

### MicroVM ライフサイクルフック

`cdk synth` の CloudFormation Validate プラグインで、`AWS::Lambda::MicrovmImage` の `Hooks.MicrovmHooks.*` と `Hooks.MicrovmImageHooks.*` は、スクリプトのパスではなく `ENABLED`/`DISABLED` のスイッチだと確認できています。フックを有効にすると、プラットフォームはコンテナの `Hooks.port` に対する HTTP リクエストとして呼び出します。

| フック | HTTP 呼び出し | タイミング | MicroVM 内サーバーの処理 |
|---|---|---|---|
| `ready`(イメージビルド時) | `GET /ready` | Dockerfile のコンテナ起動後、Firecracker のスナップショットを取る前にポーリングされる | `codex app-server` の起動と Event Handler の接続が済んだ時点で 200 を返す。 |
| `validate`(イメージビルド時) | `GET /validate` | スナップショット取得後に一度だけポーリングされる | `ready` と同じ確認。スナップショットから正常に再開できることを確かめる。 |
| `run` | `POST /run` | MicroVM が PENDING から RUNNING になるとき | `runHookPayload` の `sessionId` を読み、Event Handler に結び付ける。`codex app-server` と HTTP サーバーはスナップショットからすでに再開しているので、処理は軽い。 |
| `suspend` / `resume` | `POST /suspend` / `POST /resume` | RUNNING と SUSPENDED の切り替え | ログを出すだけ。実行中の Thread/Turn/Item を含むプロセスの状態は、Firecracker のメモリとディスクのスナップショットが保つ。 |
| `terminate` | `POST /terminate` | MicroVM を破棄する直前 | `codex app-server` を、可能な範囲で正常に停止する。 |

## 🎯 設計判断とベストプラクティス

### 1. 「実行してストリームで受け取る」手段の代わりに、MicroVM 内に HTTP サーバーを置く

Lambda MicroVMs には、起動中の MicroVM にログインしてコマンドの出力をストリームで受け取る API がありません。そこでイメージ自身に HTTP サーバーを持たせ、JSON-RPC を `codex app-server` へ中継し、出力を拾わせています。外部から必要なのは、通常の HTTPS だけです。

### 2. 出力の配信は push(WebSocket)を主に、pull(ポーリング)を正として残す

最も単純な配信方式はポーリングだけです。この実装は `EventsTable` を唯一の正としたまま、その上に push を重ねました。クライアントはいつでも `get-events` をポーリングすれば正しい結果を得られます。DynamoDB Streams から起動する `forward-event` が、新しいアイテムが書かれるたびに、接続中の WebSocket クライアントへ届けます。push は置き換えではなく追加です。WebSocket を一度も開かないクライアントは、ポーリングだけでこれまでどおり動きます。WebSocket を使うクライアントも、セッション開始から接続登録までの隙間を埋めるため、接続後に一度はポーリングしてください。

### 3. WebSocket の接続状態を、MicroVM のライフサイクルから切り離す

`ConnectionsTable` は、MicroVM の RUNNING/SUSPENDED とは無関係に、*クライアント*の接続を追跡します。MicroVM がサスペンドやレジュームをする間もクライアントは接続を開いたままにでき、次のイベントが書かれるまで出力が止まるだけです。逆に WebSocket を閉じても、MicroVM には影響しません。

### 4. Cognito の ID トークンは、WebSocket のハンドシェイクで Authorization ヘッダーに載せられない

ブラウザのアプリケーションコードは、WebSocket のハンドシェイクにカスタムヘッダーを付けられません。そこで ID トークンを `token` クエリパラメータで送り、[`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify) を使う `WebSocketLambdaAuthorizer`(`ws-authorizer.ts`)で検証しています。HTTP API では、マネージドの `HttpUserPoolAuthorizer` を使えます。WebSocket API にはこのマネージドの Authorizer が使えないため、検証の方法が異なります。

### 5. コントロールプレーンは、app-server への*入力*をプロキシしない

`create-session` と `resume-session` は、MicroVM 自身の `endpoint` と、単一ポートに限定した有効期間の短い `X-aws-proxy-auth` トークン(`CreateMicrovmAuthToken` の `allowedPorts` で発行)を返します。クライアントはこのエンドポイントへ、JSON-RPC のリクエストを直接送ります。そのため、コントロールプレーン Lambda のレイテンシとコストは、Turn のトラフィック量に左右されません。コントロールプレーンを通るのは、はるかに小さい出力配信の経路だけです。

### 6. `/rpc` は、型付きの Thread/Turn REST API ではなく汎用の中継にする

MicroVM 内サーバーの `/rpc` は、`/threads` や `/turns` といった REST のルートにメソッド名を固定せず、JSON-RPC 2.0 のリクエストボディをそのまま `codex app-server` の stdin へ渡します。`codex app-server` が持つメソッドとパラメータの正確なスキーマを、Codex CLI のソースコードで独自に検証できていないためで、HTTP の境界ではあえてプロトコルに依存しない形にしました。送るべき `initialize`、thread、turn、item のメソッドは、[Codex CLI のリポジトリ](https://github.com/openai/codex)で確認してください。

### 7. コストの面では、terminate より suspend を優先する

`idlePolicy` は、アイドルになった MicroVM を終了させず、自動でサスペンドします。課金されるのは Firecracker のスナップショットのストレージだけです。タブを閉じたなど、セッションが当面不要だとクライアントが分かっている場合は、`POST /sessions/{id}/suspend` と `/resume` を使えば、アイドルのタイムアウトを待たずに状態を切り替えられます。

### 8. OpenAI API キーは、イメージにも IaC にも入れない

`CfnMicrovmImage.environmentVariables` に入れるのは、全セッション共通で固定の `OPENAI_API_KEY_SECRET_ARN` だけです。実際のシークレットの値は、コンテナの起動時に `server/secret.mjs` が、MicroVM の `executionRoleArn` にプラットフォームが渡す認証情報を使って、Secrets Manager から取得します。

### 9. セッション・イベント・接続は、すべて所有者だけが扱える

Cognito の Subject(`sub`)が、`SessionsTable` と `ConnectionsTable` のすべてのアイテムで `ownerId` になります。呼び出し元本人のものではないセッションに対して、HTTP のルートは 404 を返し、WebSocket の `$connect` は接続を拒否します。他のユーザーの MicroVM のエンドポイントや出力が漏れることはありません。

### 10. Well-Architected Framework との整合性

| 柱 | このリファレンスでの対応 |
|---|---|
| 運用上の優秀性 | HTTP API ステージの CloudWatch アクセスログ。コントロールプレーンの Lambda ごと、MicroVM イメージごとに専用のロググループを持つ。 |
| セキュリティ | セッションごとの VM レベルの分離(Firecracker、カーネルを共有しない)。すべての HTTP ルートと WebSocket の `$connect` で Cognito による認可。所有者単位のセッション/イベント/接続レコード。DynamoDB と Secrets Manager への最小権限。 |
| 信頼性 | Turn の出力は DynamoDB に残るので、MicroVM のサスペンドや終了の影響を受けない。WebSocket の接続が切れても、ポーリングに切り替えて続けられる。NAT Gateway を1台にしているのはコストと AZ 耐障害性のトレードオフで、本番では AZ ごとに追加する。 |
| パフォーマンス効率 | MicroVM は初期化済みの Firecracker スナップショット(`codex app-server` と MicroVM 内 HTTP サーバーが起動済み)から再開するので、コールドブートがない。出力は一定間隔のポーリングではなく push で届く。 |
| コスト最適化 | `idlePolicy` による自動サスペンド。失効したセッションと接続は DynamoDB の TTL で削除。DynamoDB は終始 PAY_PER_REQUEST。WebSocket の push により、Turn が止まったあとの無駄なポーリングがなくなる。 |

## 💰 コスト最適化

このリファレンスには、リポジトリ内の他のパターンにないコスト要素があります。MicroVM の実行時間とサスペンド時間、NAT Gateway、Cognito、WebSocket API です。**ここに書いた内容を見積もりとして使わないでください。** 実際のワークロードの費用を見積もる前に、利用するリージョンの料金ページ(Lambda MicroVMs、NAT Gateway、Cognito、API Gateway の WebSocket API、DynamoDB)を確認してください。

コストの要因を、影響の大きい順に挙げます。

1. **MicroVM の RUNNING 時間。** セッションの MicroVM が稼働している間は課金されます。Codex のセッションが動いている間は、これが最大の要因です。
2. **MicroVM の SUSPENDED 時間。** 課金されるのは、Firecracker のスナップショットのストレージだけです。レイテンシだけでなくコストの点でも、`idlePolicy` と明示的な `/suspend` ルートが効きます。Turn の出力は `EventsTable` にあるため、こまめにサスペンドしても出力は失われません。
3. **NAT Gateway。** 時間課金に加えて、`codex app-server` と OpenAI API の間で送受信するすべてのバイトにデータ処理料金がかかります。NAT Gateway を1台にした構成(デフォルト)が最も安く済みます。インターネットへの通信のほかに MicroVM が AWS サービスと通信する必要があるなら、VPC エンドポイントを検討してください。
4. **Cognito。** 無料利用枠が一定数の MAU をカバーし、それを超えると MAU 単位の課金が始まります。Plus 機能プラン(`AwsSolutions-COG8`、この実装では抑制済み)を有効にすると、MAU 単位の費用がさらに加わります。
5. **WebSocket API の接続時間とメッセージ。** 接続時間とメッセージ数の両方に課金されます。短いポーリングを繰り返す代わりに、開いた接続1本と、イベント1件につきメッセージ1件で済むので、出力が頻繁なときは通常ポーリングより安く済みます。ただし、ポーリングだけの構成にはない費用です。`forward-event` の DynamoDB Streams 起動は、通常の Lambda 呼び出しとして課金されます。
6. **API Gateway HTTP API とコントロールプレーンの Lambda。** 上の項目に比べれば無視できる額です。扱うのはセッションのライフサイクルと出力の配信だけで、Turn の入力トラフィックは通りません。
7. **DynamoDB。** PAY_PER_REQUEST と短い TTL のおかげで、通常のセッション数ならほぼゼロです。ただし `EventsTable` には、`codex app-server` の出力1行につき1アイテムを書き込みます。イベントが非常に多いときは、このテーブルの書き込み費用と、対応する `forward-event` の呼び出し回数に注意してください。

### このパターン固有の注意

- コストを抑えたい環境では、`controlPlane.idleTimeoutInMinutes` を短くします。未使用の MicroVM が早くサスペンドされますが、次のリクエストでレジュームの往復が増えます。
- `controlPlane.suspendedDurationInMinutes` は、放置されたセッションがプラットフォームに完全に終了されるまで、スナップショットのストレージ料金を払い続ける期間の上限です。`sessionRecordTtlInDays` と合わせて決めてください。
- ライブ更新が間欠的でよいクライアントは、WebSocket を開かず `get-events` のポーリングだけにすると安く済む場合があります。push は応答性のための経路で、動作の正しさには必要ありません。

## 🔒 セキュリティ考慮事項

### 実装済み

- セッションごとの VM レベルの分離(Firecracker MicroVM、セッション間でカーネルを共有しない)。
- すべての HTTP コントロールプレーンのルートで Cognito による認可(`HttpUserPoolAuthorizer`)。WebSocket API の `$connect` でも、同じユーザープールの ID トークンを検証する `WebSocketLambdaAuthorizer` で認可。
- JWT の `ownerId`(`sub`)による、セッション・イベント・接続レコードの所有者単位のアクセス制御。
- OpenAI API キーは Secrets Manager にだけ置き、イメージに入るのはその ARN だけ。
- DynamoDB(`grantReadWriteData`、`grantWriteData`、`grantReadData` をそれぞれ1つのテーブルに限定)と Secrets Manager(`grantRead` を対象のシークレット1つに限定)への最小権限。`forward-event` の `execute-api:ManageConnections` は、1つの WebSocket API ステージに限定。
- MicroVM の egress 経路用に、アウトバウンド専用のセキュリティグループ(インバウンドルールなし)。

### 意図的に対象外にしたもの(環境ごとに追加してください)

- HTTP API 向けの WAFv2 Web ACL(WAF は WebSocket API に対応していない)。
- Lambda ハンドラー自身が行う以上の、リクエストボディやスキーマの検証。
- Cognito の MFA と Plus 機能プラン(高度なセキュリティ機能)。
- VPC フローログ。
- Secrets Manager の自動ローテーション(ローテーション用 Lambda を持たないサードパーティの API キーには使えないため、手動でローテーションする)。
- MicroVM 内サーバーの `/rpc` に対する、プラットフォームの `X-aws-proxy-auth` とは別の追加認証。有効な MicroVM 認証トークンを持っていれば、同じ `Hooks.port` を使う `/rpc`、`/run`、`/suspend`、`/resume`、`/terminate` のどれにも到達できます。プラットフォームのフック呼び出しがクライアントのトラフィックと分離されていない場合は、環境ごとに制限を追加してください。

### 実機デプロイ検証で解決した2点

以前は未検証としていた次の2点は、2026-09-27 の実機デプロイで正しいと確認できました(詳しくは[実機デプロイ検証](#-実機デプロイ検証)を参照)。

1. **IAM の信頼ポリシー。** `microvmServicePrincipal` に `lambda.amazonaws.com` を使う実装で、イメージのビルドも MicroVM の実行も成功しました。
2. **`codex app-server` の JSON-RPC フレーミング。** 改行区切りの JSON(stdio)で正しく、`/rpc` 経由の実際の `initialize` のリクエストとレスポンスが、変更なしで往復できました。

### CDK Nag

`test/compliance/cdk-nag.test.ts` が `AwsSolutionsChecks` を実行し、抑制していない警告やエラーがゼロであることを確かめます。抑制にはすべて理由があり、上の「意図的に対象外にしたもの」のどれかに対応しています。加えて、MicroVM データプレーンのアクション向けに `AwsSolutions-IAM5` も抑制しています。これらのリソース ARN(MicroVM とイメージの識別子)は `RunMicrovm` の実行時に決まるため、デプロイ前には絞り込めないからです。

## 📋 前提条件

- Node.js 20.x 以降、AWS CDK CLI、リポジトリ直下の README にある AWS プロファイルの設定。
- **実在する MicroVM のベースイメージの ARN とバージョン。** `parameters/dev-params.ts` にはプレースホルダーが入っています。次のコマンドで実際の値を調べ、デプロイ前に書き換えてください。

  ```sh
  aws lambda-microvms list-managed-microvm-images
  aws lambda-microvms list-managed-microvm-image-versions --image-identifier <上で得た arn>
  ```

  ARN の形式は `arn:aws:lambda:<region>:aws:microvm-image:<name>-<version>`(例: `arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1`)です。名前空間は `lambda:` で、アカウント部分は `aws:` になります。`arn:aws:lambda-microvms:...:image/...` ではありません。
- 対象のアカウントとリージョンで AWS Lambda MicroVMs が使えること。この実装を作った時点ではプレビューまたは限定提供の可能性があるので、アカウントで有効になっているか確認してください。
- 初回デプロイ後に `OpenAiApiKeySecret`(ARN はスタックの出力にある)へ設定する、OpenAI API キー。

## 🚀 デプロイ手順

```sh
cd infrastructure
npm install

# 1. parameters/dev-params.ts を実際の baseImageArn / baseImageVersion に書き換える

# 2. デプロイ
npm run deploy:all -w workspaces/lambda-microvms-codex-appserver --project=<project> --env=dev

# 3. OpenAI API キーを設定する(ARN はスタック出力の OpenAiApiKeySecretArn)
aws secretsmanager put-secret-value \
  --secret-id <OpenAiApiKeySecretArn> \
  --secret-string 'sk-...'

# 4. 認証に使う Cognito ユーザーを作る(UserPoolId はスタック出力)
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com
aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> --username you@example.com \
  --password '<強力なパスワード>' --permanent
```

## 使い方

```sh
# User Pool Client(スタック出力の UserPoolClientId)で認証して ID トークンを取得し、セッションを開始する
curl -X POST "$API_URL/sessions" -H "Authorization: Bearer $ID_TOKEN"
# => { "sessionId": "...", "state": "PENDING", "endpoint": "https://...", "authToken": { "X-aws-proxy-auth": "..." } }

# 出力を書かれた順に受け取るため、WebSocket に接続する(WebSocketUrl はスタック出力)
wscat -c "$WEBSOCKET_URL?sessionId=$SESSION_ID&token=$ID_TOKEN"

# MicroVM 自身のエンドポイントへ、JSON-RPC のリクエストを直接送る
# (initialize / thread / turn の実際のメソッド名とパラメータは Codex CLI のドキュメントを参照)
curl -X POST "$ENDPOINT/rpc" -H "X-aws-proxy-auth: $AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# 出力は、書かれた順に WebSocket の接続へ届く。接続の登録前に書かれた分を取りたいとき、
# または WebSocket を維持したくないときは、代わりにポーリングする
curl "$API_URL/sessions/$SESSION_ID/events?after=0" -H "Authorization: Bearer $ID_TOKEN"

# 終了するとき
curl -X DELETE "$API_URL/sessions/$SESSION_ID" -H "Authorization: Bearer $ID_TOKEN"
```

## 🧪 テスト戦略

```sh
npm run test:unit -w workspaces/lambda-microvms-codex-appserver        # リソースのプロパティを検証
npm run test:snapshot -w workspaces/lambda-microvms-codex-appserver    # テンプレート全体の回帰テスト
npm run test:compliance -w workspaces/lambda-microvms-codex-appserver  # cdk-nag の AwsSolutions パック
```

`cdk synth` 自体も、`AWS::Lambda::MicrovmImage` と `AWS::Lambda::NetworkConnector` の CloudFormation スキーマに対してテンプレートを検証します(CloudFormation Validate プラグイン)。`hooks` や `cpuConfigurations` を変更したときは、出力される `W3030` の警告を確認してください。

## ⚙️ カスタマイズ

### WebSocket の経路を外して、ポーリングだけにする

リアルタイムに近い更新が要らないクライアントは、`GET /sessions/{id}/events` だけを呼び、WebSocket を一切開かなくても構いません。どちらの経路でも `EventsTable` が正なので、サーバー側の変更は不要です。WebSocket の基盤ごと外すなら、`WebSocketApi`、`WebSocketStage`、`ws-*` と `forward-event` の各 Lambda、`ConnectionsTable`、`EventsTable` の `stream` プロパティを削除します。

### MicroVM データプレーンの IAM アクションをさらに絞る

アカウント内の MicroVM とイメージのリソースについて、安定した ARN のパターンが分かっているなら、`lib/stacks/lambda-microvms-codex-appserver-stack.ts` の `microvmDataPlanePolicy` にある `resources: ['*']` をそのパターンに置き換えます。あわせて、対応する `AwsSolutions-IAM5` の抑制も削除してください。

### AZ ごとに NAT Gateway を置く

`Vpc` コンストラクトの `natGateways: 1` を `natGateways: 2` に変えると、本番相当の AZ 耐障害性になります。NAT Gateway の費用はほぼ倍になります。

## ✅ 実機デプロイ検証

2026-09-27 に実際のアカウント(`ap-northeast-1`)へデプロイし、インフラと JSON-RPC のプロトコルの水準で検証して、スタックを削除しました。OpenAI API キーは使っていません。インフラの検証に絞ったため、OpenAI API キーで認証される実際の Turn は実行していません。この検証で6件の不具合を見つけて直しました。どれも静的なチェック(`cdk synth`、ユニットテスト、cdk-nag)では検出できず、実サービスの挙動でしか分かりません。

1. **`AWS::Lambda::NetworkConnector` は、`VPC_EGRESS` のコネクタに `operatorRole` が必要。** `"NetworkConnectorOperatorRole is required for VPC_EGRESS connector type"` で `CREATE_FAILED` になりました。IAM ロール(マネージドポリシー `AWSLambdaVPCAccessExecutionRole`)を追加し、`operatorRole` として渡しています。
2. **イメージビルドの `/ready` と `/validate` のフックは、実行ロールではなくビルドロールの認証情報で動く。** 実行ロールにはすでに権限があったのに、ビルドロールを名指しした `secretsmanager:GetSecretValue` の `AccessDeniedException` でビルドが失敗しました。ビルドロールにも同じ読み取り権限を付けています。
3. **`CODEX_HOME` のディレクトリがないと、`codex app-server` が起動を拒否する。** Dockerfile の `ENV CODEX_HOME=...` だけではディレクトリは作られません。`RUN mkdir -p "$CODEX_HOME"` を追加しました。
4. **ライフサイクルフックのパスは、`/ready` のような裸のパスではなく `/aws/lambda-microvms/runtime/v1/<hook-name>` 配下。** AWS Lambda MicroVMs の Developer Guide にある OpenAPI 仕様で確認しました。裸の `/ready` にしか応答しないサーバーは、すべてのフック呼び出しで黙って 404 を返され、ビルドはアプリケーションのエラーが出ないままタイムアウトしました。2回連続で失敗していたビルドが次の試行で通ったのは、この修正のおかげです。あわせて、`/run` フックのボディは `{ microvmId, runHookPayload }` で、`runHookPayload` は文字列なので二重に `JSON.parse` が必要なことも分かりました(`{ sessionId }` が直接届くわけではありません)。
5. **IAM アクションのプレフィックスは `lambda-microvms:` ではなく `lambda:`。** 専用の SDK/CLI 名前空間があるのに、`RunMicrovm` などは Lambda 本体の名前空間で認可されます。`lambda:RunMicrovm` を名指しした実際の `AccessDeniedException` で確認しました。
6. **`RunMicrovm` には、egress コネクタの ARN に対する `lambda:PassNetworkConnector`(`PassRole` に似た権限)が必要。** さらに、`ingressNetworkConnectors` を設定していなくても暗黙に付く、AWS 管理の ingress コネクタ(`arn:...:network-connector:aws-network-connector:HTTP_INGRESS`)にも同じ権限が必要でした。

確認の手順を含む詳細は、[`docs/knowledge/lambda-microvms.md`](../../../docs/knowledge/lambda-microvms.md)にあります。

6件を直したうえで、エンドツーエンドで確認できた内容は次のとおりです。

- `cdk deploy '**'` が、VPC と NAT、Cognito、HTTP API と WebSocket API、Lambda 10個、MicroVM イメージを含むスタック全体を問題なく作成した。
- 実際に Cognito で認証したユーザーとして `POST /sessions` を呼ぶと、実際の MicroVM のエンドポイントと認証トークンが付いた `201` が返った。`GET /sessions/{id}` で、MicroVM が `RUNNING` になったことも確認した。
- `X-aws-proxy-auth` を付けて `POST {endpoint}/rpc` を呼ぶと MicroVM 内サーバーに届き、stdio で実際の `codex app-server` の子プロセスへ中継された。不正な `initialize` には codex 自身が本物の JSON-RPC エラー(`missing field 'clientInfo'`)を返し、直したリクエストにはハンドシェイクの成功レスポンス(`codexHome`、`platformOs` など)が返った。
- `GET /sessions/{id}/events` で、DynamoDB Streams のパイプラインが機能していることを確認した。`initialize` のレスポンス、`bubblewrap` のサンドボックス依存が見つからないという codex からの `configWarning`、`remoteControl/status/changed` のイベントが、すべて保存され読み出せた。
- `DELETE /sessions/{id}`(`TerminateMicrovm`)で、試した2台の MicroVM がどちらも `TERMINATED` になったことを、`aws lambda-microvms list-microvms` で確認した。
- 検証のあとスタックを削除し、完全に消えたことを確認した。

確認できていないこと: 実際の OpenAI API キーでの Turn(本物のキーが必要)、サスペンドとレジューム、トラフィックによる自動レジューム、WebSocket の push 配信の経路。

## 🔧 トラブルシューティング

### `cdk deploy` が `CfnMicrovmImage` の検証で失敗する

`parameters/dev-params.ts` の `baseImageArn` と `baseImageVersion` を確認してください。プレースホルダーのままではデプロイで失敗します。`aws lambda-microvms list-managed-microvm-images` を再実行して、現在の値を取得します。

### `AWS::Lambda::MicrovmImage ... did not stabilize`(アプリケーションのログが一切ない)

多くの場合、MicroVM 内サーバーが、フックを間違ったパスで待ち受けています。Lambda はライフサイクルフックを、`/ready` のような裸のパスではなく、`POST /aws/lambda-microvms/runtime/v1/<hook-name>` として呼びます。`/ready` しか認識しないサーバーはすべての呼び出しに 404 を返し、ビルドは手がかりのないままタイムアウトします。アプリケーションから見れば 404 を返しただけの正常な処理なので、エラーとしては表に出ません。ビルドの `MicrovmImageLogGroup` を確認してください。サーバー自身の「listening」のログは出ているのにその後何も起きていなければ、この可能性が高いです。詳しくは `docs/knowledge/lambda-microvms.md` を参照してください。

ビルドのロググループに**ログストリームが1つもない**ときは、ビルドロールに、設定したロググループへの `logs:CreateLogStream` と `PutLogEvents` の権限があるか確認します。`logging.cloudWatch.logGroup` を設定しただけでは、書き込みの権限は付きません。

### `RunMicrovm` が `AccessDeniedException` で失敗し、`lambda:RunMicrovm`、`lambda:PassNetworkConnector`、`secretsmanager:GetSecretValue` のどれかが名指しされる

- `lambda:RunMicrovm`(ほかの MicroVM データプレーンのアクションも同様): IAM ポリシーのアクションのプレフィックスが、`lambda-microvms:` ではなく `lambda:` になっているか確認してください。専用の SDK/CLI 名前空間はありますが、認可は Lambda 本体の名前空間で行われます。
- `lambda:PassNetworkConnector`: `RunMicrovmRequest.egressNetworkConnectors` には、コネクタ自身の ARN に対する `PassRole` に似た権限が必要です。エラーが、参照した覚えのない AWS 管理の ARN `arn:...:network-connector:aws-network-connector:HTTP_INGRESS` を名指ししているときは、`ingressNetworkConnectors` を設定していなくても `RunMicrovm` が既定の ingress コネクタを暗黙に付けています。`arn:<partition>:lambda:<region>:aws:network-connector:aws-network-connector:*` にも `PassNetworkConnector` を付けてください。
- `secretsmanager:GetSecretValue` が、実行ロールではなく**ビルドロール**を名指ししているとき: アプリケーションが起動時にシークレットを解決していて、ビルドの `/ready` と `/validate` のフックは実行ロールではなくビルドロールの認証情報で動きます。ビルドロールにも同じ読み取り権限を付けてください。

`cdk deploy` が成功と報告した直後に、直したはずの権限で同じエラーが続くときは、修正が間違っているのではなく、IAM の反映の遅れを疑ってください。まずデプロイ済みのテンプレート(`aws cloudformation get-template`)に正しいポリシーがあるか確認し、少し待ってから再試行します。

### `RunMicrovm` は成功するが、`POST {endpoint}/rpc` に応答がない

MicroVM の CloudWatch ロググループ(`MicrovmImageLogGroup`)で、`[server]` と `[codex app-server]` のログを確認してください。MicroVM 内サーバーが「listening」を一度も出していない場合、`server/index.mjs` がポートを開く前に、コンテナの `ENTRYPOINT` が失敗している可能性があります。イメージに入れた `npm install` が失敗していないか、`codex app-server` が `CODEX_HOME points to "..." but that path does not exist` で即座に終了していないかを確認します。Dockerfile で `ENV CODEX_HOME=...` を設定してもディレクトリは作られないので、`RUN mkdir -p "$CODEX_HOME"` が必要です。

### `GET /sessions/{id}/events` が、いつも空のリストを返す

`create-session` が `runHookPayload` を送っているか確認してください。MicroVM 内サーバーの `/run` ハンドラーが `sessionId` を受け取っていないと、Event Handler は結び付け先が分からず、各行を書き込まずに捨てます(`server/event-handler.mjs` を参照)。

### WebSocket の接続がコード 1008 ですぐ閉じる(または `$connect` が 401/404 相当を返す)

- 401 相当の拒否: `ws-authorizer` が `token` クエリパラメータを検証できていません。デプロイしたスタックと同じユーザープールとクライアントの Cognito **ID トークン**(アクセストークンではありません)を渡しているか確認してください。
- 404 相当の拒否: `ws-connect` が、そのトークンの `sub` を所有者とする `sessionId` のセッションを見つけられていません。同じ Cognito ユーザーで先に `POST /sessions` を呼んでいるか確認してください。

### WebSocket には接続できるが、イベントが1件も届かない

`ForwardEventFunctionLogGroup` で、`GoneException` などの `PostToConnection` のエラーを確認してください。ログが何もないときは、`EventsTable` の DynamoDB Streams トリガー(`AWS::Lambda::EventSourceMapping`)が `Enabled` か、実際にイベントが書かれているか(前の項目を参照)を確認します。

### `codex app-server` は起動するが、すぐ認証エラーになる

`OPENAI_API_KEY_SECRET_ARN` が指す Secrets Manager のシークレットの値が、初回デプロイで作られたプレースホルダーのままです。「デプロイ手順」の `put-secret-value` を実行してください。

## 🧹 クリーンアップ

```sh
npm run destroy:all -w workspaces/lambda-microvms-codex-appserver --project=<project> --env=dev
```

スタックを破棄する前に、RUNNING や SUSPENDED のセッションが残っていれば、`DELETE /sessions/{id}` で終了させてください。`cdk destroy` は `TerminateMicrovm` を自動では呼びません。

## 📚 参考資料

### AWS 公式ドキュメント

- [AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)
- [Announcing Lambda MicroVMs (AWS Compute Blog)](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/)
- [API Gateway WebSocket APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html)

### Codex

- [OpenAI Codex CLI(`codex app-server`)](https://github.com/openai/codex)

### 関連アーキテクチャ

- [`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/README.ja.md): このコントロールプレーンの HTTP ルーティングが踏襲した、API Gateway と Lambda のパターン。

## 📄 ライセンス

このプロジェクトは Apache License, Version 2.0 の下でライセンスされています。詳細は [LICENSE](../../../LICENSE) ファイルを参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は[コントリビューションガイド](../../../docs/contribution/CONTRIBUTING.md)を参照してください。

## 🏆 このリファレンスアーキテクチャについて

このリファレンスアーキテクチャは、VM 分離されたセッション型のサーバーレスコンピュートバックエンドを構築するための、AWS CDK のベストプラクティスを示しています。

**対象レベル**: 300(上級)

---

**注意**: これはリファレンス実装です。本番環境にデプロイする前に、必ず特定の要件および組織のポリシーに従ってレビューおよびカスタマイズしてください。
