# Lambda durable functions による承認ワークフロー - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

申請 → 承認者への通知 → **最大 48 時間の承認待ち** → 実行 / 却下 / 期限切れ、という人の判断を挟む業務フローを、**1 つの Lambda durable function** で実装します。待機中は関数が停止するため compute 課金は発生せず、承認 API が `SendDurableExecutionCallbackSuccess` を呼んだ時点で、関数が checkpoint から再開(replay)します。

ワークフローはふつうの TypeScript の逐次コードで、Step Functions の状態機械定義はありません。代わりに、durable functions 固有の制約(決定性、qualified ARN、バージョン固定、冪等性)をコードとインフラの両方で守る必要があります。本ワークスペースはその守り方を示すことを目的にしています。

オプションの**デモ用 Web 画面**(Cognito マネージドログイン + CloudFront/S3)を使うと、2 人で申請者と承認者を分担してブラウザから操作できます。画面は同じ IAM 認証 API を SigV4 で呼ぶため、API の認可方式は変わりません。

> **ステータス: 2026-10-21 にデプロイ検証済み**(ap-northeast-1、`aws-cdk-lib` 2.273.0)。[デプロイ検証の結果](#-デプロイ検証の結果)を参照。

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [durable functions の仕組み(本構成に関係する部分)](#-durable-functions-の仕組み本構成に関係する部分)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [Step Functions との比較](#-step-functions-との比較)
- [コスト](#-コスト)
- [セキュリティに関する考慮事項](#-セキュリティに関する考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [使い方](#使い方)
- [デモ用 Web 画面](#️-デモ用-web-画面)
- [テスト戦略](#-テスト戦略)
- [運用](#-運用)
- [デプロイ検証の結果](#-デプロイ検証の結果)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![アーキテクチャ図](overview.drawio.svg)

```text
Client (SigV4 / IAM)          ブラウザ (デモ画面, オプション)
  │                             ├─ CloudFront (OAC) ─▶ S3: index.html / app.js / config.json
  │                             ├─ Cognito ユーザープール (マネージドログイン, 認可コード + PKCE) ─▶ ID トークン
  │                             └─ Cognito ID プール ─▶ グループに対応する IAM ロールの一時認証情報
  ▼                             ▼ (SigV4, CORS は画面のオリジンのみ)
API Gateway (REST, AWS_IAM, JSON Schema 検証, スロットリング)
  ├─ POST /requests                 → StartRequest ──Invoke(Event, DurableExecutionName)──▶ Workflow:live (durable)
  ├─ POST /requests/{id}/decision   → SubmitDecision ──SendDurableExecutionCallbackSuccess──▶ (待機中の実行が再開)
  ├─ GET  /requests/{id}            → GetRequest ──▶ DynamoDB (状態の射影)
  └─ GET  /requests?status=…        → ListRequests ──▶ DynamoDB GSI status-createdAt (承認者の作業一覧)

Workflow (durable function, alias: live)
  register-request ─▶ wait-for-approval (callback, 最大 48h, 待機中は課金なし) ─┬─ 承認 ─▶ fulfill-request ─▶ mark-completed
        │                    │ submitter: callbackId を DynamoDB へ / SNS で承認者へ通知  ├─ 却下 ─▶ mark-rejected
        ▼                    ▼                                                          └─ 期限 ─▶ mark-expired
     DynamoDB             SNS (承認依頼, KMS)

運用: EventBridge "Durable Execution Status Change" (FAILED / TIMED_OUT / STOPPED) ─▶ SNS (アラート)
      DLQ (SQS) ─▶ CloudWatch Alarm ─▶ SNS (アラート)
```

### 主要コンポーネント

| コンポーネント | 役割 |
|---|---|
| `WorkflowFunction`(durable) | 承認フロー本体。`DurableConfig`: 実行タイムアウト 7 日、履歴保持 14 日。invocation ごとのタイムアウトは 60 秒 |
| `live` エイリアス | 新しい実行は必ずこのエイリアス(= 発行済みバージョン)で開始する |
| `StartRequest` | 申請を受け付け、`DurableExecutionName` を付けて**非同期**で実行を開始する |
| `SubmitDecision` | 承認・却下を受け付け、callback を完了させる |
| `GetRequest` | DynamoDB から状態を返す。`GetDurableExecution` は使わない |
| `ListRequests` | 承認者の作業一覧。指定した状態の新しい順 50 件を `status-createdAt-index` GSI から返す |
| DynamoDB `requests` | 状態の射影と `callbackId` の保管場所 |
| SNS(承認依頼 / アラート) | KMS カスタマー管理キーで暗号化 |
| SQS DLQ | 失敗した実行の元イベントを保存する |
| EventBridge ルール | この関数の異常終了だけを拾ってアラートを出す |
| デモ用 Web 画面(`DemoWebUi` Construct、オプション) | Cognito ユーザープール(グループ `requesters` / `approvers`)+ ID プール、グループごとの IAM ロール、SPA 配信用の CloudFront + 非公開 S3 |

## 🔁 durable functions の仕組み(本構成に関係する部分)

- **checkpoint と replay**: `context.step()` の結果は checkpoint として保存されます。再開時はハンドラーが**先頭から再実行**され、完了済みの step は実行せず保存済みの結果を返します。
- **待機**: `waitForCallback()` は callback ID を発行して submitter を実行し、関数を停止させます。外部から `SendDurableExecutionCallbackSuccess` が届くか、タイムアウトになると再開します。
- **時間の上限**: 1 回の invocation は最大 15 分のままです。実行全体は `executionTimeout`(最大 366 日)まで続けられます。ただし**同期呼び出しと event source mapping 経由の起動では、実行全体が 15 分に制限されます**。そのため本構成では非同期 invoke を使います。
- **バージョン固定**: 実行は開始したバージョンに固定されます。エイリアスを切り替えても、実行中のものは古いバージョンで再開します。

## 🎯 設計判断とベストプラクティス

### 1. 非同期 invoke + `DurableExecutionName` で開始を冪等にする

`StartRequest` は `InvocationType: 'Event'` と `DurableExecutionName: approval-<requestId>` を指定して起動します。同じ名前・同じペイロードの再送は既存の実行を返します。

**ペイロードが違っても、非同期 invoke では拒否されません**(デプロイ検証で確認)。`Invoke` は 202 と既存の実行 ARN を返し、実行が終了した後でも同じです。新しいイベントは裏で `DurableExecutionAlreadyExists. An execution with this name already exists with different payload.` として失敗して DLQ に入り、DLQ アラームも発報します。`Event` の invoke では `DurableExecutionAlreadyStartedException` は発生しません。そのため `StartRequest` は先に状態の射影を読み、同じ request ID が別の件名・金額・申請者で存在すれば、invoke せずに HTTP 409 を返します。最初の step がアイテムを書き込む前(約 1 秒)に届いた食い違う再送だけは、引き続き DLQ に入ります。

- クライアントは `Idempotency-Key` ヘッダーで request ID を指定できます(1〜55 文字の `[A-Za-z0-9_-]`。実行名の上限 64 文字から接頭辞 `approval-` を引いた長さ)。
- **ペイロードにタイムスタンプを入れない**: 冪等性の判定はペイロードの一致で行われるため、再送でも同じバイト列になるように組み立てます。

> 公式ドキュメントの intermediary function のサンプル(TypeScript)は `executionName` をペイロードに入れているだけで、`DurableExecutionName` パラメーターを指定していません。そのままでは冪等になりません。

### 2. 本番の実行は必ず `live` エイリアス経由、古いバージョンは保持する

- `$LATEST` で開始した実行は、待機中にコードを更新すると**新しいコードで replay されます**。step の追加や名前の変更があると、checkpoint と一致しなくなって壊れます。
- `currentVersionOptions.removalPolicy: RETAIN` を指定し、デプロイで古い `AWS::Lambda::Version` が消えないようにしています。消すと、そのバージョンで待機中の実行が再開できません。
- その代わりバージョンは増え続けます。実行中のものがないバージョンを定期的に削除する運用が必要です(→ [運用](#-運用))。

### 3. 非決定的な処理は step の中に入れる

時刻・乱数・外部 I/O はすべて `step` か callback の submitter の中で実行します。`parseDecision()` は checkpoint 済みの callback 結果だけから決まる純粋関数なので、step の外に置いています。**step 名は checkpoint との対応付けに使われる**ため、実行中の実行があるバージョンで step 名を変えてはいけません。

### 4. step は少なくとも 1 回は実行される前提で書く

step のデフォルトの実行保証は at-least-once per retry です(中断のタイミングによっては再実行されます)。そのため DynamoDB への書き込みはすべて条件付きか冪等にしています。

| 処理 | 方法 |
|---|---|
| 登録 | `attribute_not_exists(requestId)` |
| 承認待ち化 | `status IN (SUBMITTED, WAITING_APPROVAL)` |
| 実行(fulfill) | 決定的な ID と `if_not_exists` |
| 決定の取得 | `status = WAITING_APPROVAL AND callbackId = :cb`(先に取得した 1 人だけが決定できる) |

決済のように冪等にできない処理では、`StepSemantics.AtMostOncePerRetry` とリトライなしを組み合わせ、冪等キーは**別の step の中で**生成します(コード内のコメント参照)。

### 5. 状態照会に `GetDurableExecution` を使わない

`GetDurableExecution` は **30 リクエスト/秒**(リージョン単位)しかありません。ユーザー向けの状態照会に使うとすぐ上限に達するため、step で DynamoDB に状態を書き出し、API はそこから読みます。

### 6. callback ID をクライアントに渡さない

承認者は request ID で決定を送ります。callback ID は DynamoDB にだけ保存し、GET の応答からは除外しています。SNS の通知文にも含めません。さらに、申請者本人による承認は 403 で拒否します(職務分掌)。

呼び出し元の識別には IAM プリンシパルの ARN を使いますが、**Cognito ID プールの認証情報だけは Cognito の identity ID を使います**。ID プールのセッションは同じロールなら全員が同じ ARN(`assumed-role/<role>/CognitoIdentityCredentials`、実機で確認)になるため、ARN で比べるとそのロールの全ユーザーが同一人物として扱われてしまいます。

### 7. 失敗の検知は EventBridge と DLQ の 2 本立て

非同期で起動した durable execution は、失敗しても Lambda が自動でリトライしません。

- EventBridge `Durable Execution Status Change` で `FAILED` / `TIMED_OUT` / `STOPPED` を即時にアラートします。`functionArn` の prefix 条件は `<関数ARN>:` とし、末尾にコロンを付けることで `<name>-v2` のような別の関数を拾わないようにしています。
- DLQ には失敗した実行の**元イベント**が残ります。EventBridge のイベントには元のペイロードが含まれないため、再処理にはこちらを使います。
- durable functions は Lambda destinations に対応していないため、DLQ を使います。

### 8. `@aws-sdk/client-lambda` は関数に同梱する

`StartRequest` と `SubmitDecision` は `bundleAwsSDK: true` を指定しています。`DurableExecutionName` や callback API に対応した SDK が runtime に入っているかは確認できていないためです(未確認)。durable execution SDK も、公式の推奨どおりデプロイパッケージに同梱し、メジャーバージョンを固定しています(`^2.7.1`)。

### 9. デモ画面は Cognito オーソライザーを足さず、IAM 認証のまま使う

ブラウザは Cognito の ID トークンを ID プールで IAM の一時認証情報に交換し、SigV4 で署名して API を呼びます。API とハンドラーは IAM クライアント向けのものをそのまま使います。

- **グループごとのロール**: ID プールはトークンの `cognito:preferred_role` でロールを決めます(該当なしは Deny)。`requesters` のロールは `POST /requests` と `GET /requests/*`、`approvers` のロールは `GET /requests`、`GET /requests/*`、`POST /requests/*/decision` だけを呼べます。申請者が決定しようとすると、**コードが動く前に API Gateway が 403 を返します**。両方のグループに入ったユーザーには、ハンドラー側の判定が効きます。
- **CORS は画面のオリジンだけ**: OPTIONS メソッド(認証なしのモック統合)、`DEFAULT_4XX` / `DEFAULT_5XX` のゲートウェイレスポンス、ハンドラーが返す `Access-Control-Allow-Origin`。ゲートウェイレスポンスがないと、IAM による拒否がブラウザでは中身の読めないネットワークエラーになります。
- **ブラウザに秘密を置かない**: シークレットなしのアプリクライアント + 認可コード + PKCE、トークンは `sessionStorage`、CSP で接続先を API・Cognito Identity・Cognito ドメインに限定。
- **一覧も最小権限**: 申請者は一覧を取得できません。画面は申請者が作成した ID を `localStorage` に持ち、`GET /requests/{id}` をポーリングします。
- `demoWebUi.enabled: false` にすると、画面・Cognito・CORS のリソースはすべて作られません(ユニットテストで確認)。

## 🔀 Step Functions との比較

| 観点 | 本構成(durable functions) | Step Functions(例: [`fis-arch-f-stepfunctions-saga`](../fis-arch-f-stepfunctions-saga/)) |
|---|---|---|
| フローの書き方 | TypeScript の逐次コード | ASL / CDK による状態機械 |
| 承認待ち | `waitForCallback`(待機中は課金なし) | `.waitForTaskToken` |
| 他の AWS サービスとの統合 | SDK 呼び出しを step で包む | 220 以上のサービスとネイティブ統合 |
| 可視化 | 実行履歴 API / コンソール | 実行グラフ |
| 主な落とし穴 | 決定性、バージョン固定、step 名の互換性 | 状態遷移数による課金、ASL の表現力 |

Lambda の中で業務ロジックとフローが密に結び付いているなら durable functions、多数の AWS サービスをつなぐフローや非エンジニアがフローを確認する必要があるなら Step Functions が向いています。これは AWS ドキュメントの比較の要約です。

## 💰 コスト

durable functions には、通常の Lambda 課金に加えて **durable operation 数・書き込みデータ量・保持データ量** の課金があります。単価は AWS 料金ページの計算例(us-east-1)から読み取ったもので、確認日は 2026-10-21 です。

| 項目 | us-east-1 | ap-northeast-1 |
|---|---|---|
| durable operation | $8.00 / 100 万 | 未確認 |
| 書き込みデータ | $0.25 / GB | 未確認 |
| 保持データ | $0.15 / GB-月 | 未確認 |

**試算の考え方**(月 1 万件の申請):

- 1 実行あたりの operation 数は、開始 1 と各 step です。`waitForCallback` は内部で child context・callback・submitter step を使うため、複数の operation として数えられる可能性があります(未確認)。仮に 1 実行 7 operation とすると、7 万 operation × $8 / 100 万 = **約 $0.56**。
- checkpoint はどれも 1KB 未満なので、書き込み・保持の費用は誤差の範囲です。
- compute は 1 実行あたり 2〜3 回の短い invocation(replay を含む)で、待機中の 48 時間は課金されません。
- デプロイ後に `DurableExecutionOperations` と `DurableExecutionStorageWrittenBytes` メトリクスで実測値を確認してください。

そのほか、KMS カスタマー管理キー(月額の鍵料金)、API Gateway、DynamoDB(オンデマンド)、SNS がかかります。

デモ画面を有効にすると、CloudFront と S3(小さなファイル数個)、**Essentials** プランの Cognito ユーザープール(月間アクティブユーザー単位の課金。[Cognito の料金](https://aws.amazon.com/cognito/pricing/)を参照。ここでは試算していません)、デプロイ時だけ動く BucketDeployment の Lambda が加わります。ID プール自体は無料です。

## 🔒 セキュリティに関する考慮事項

### 実装済み

- API はすべて `AWS_IAM` 認可、JSON Schema による入力検証、ステージ単位のスロットリング、アクセスログ。
- callback API の権限は `lambda:SendDurableExecutionCallbackSuccess` だけを `<関数ARN>:*` に付与。durable execution の ARN(`<function-arn>:<version>/durable-execution/...`)で認可されるため、修飾なしの関数 ARN では一致しません。
- API のハンドラーには `StopDurableExecution` / `GetDurableExecutionHistory` を付与していない。
- SNS は KMS カスタマー管理キー(ローテーション有効)、SQS は SSE-SQS、どちらも TLS を強制。
- callback ID は API 応答と通知文に含めない。申請者本人は承認できない。
- デモ画面: ユーザーは管理者が作成(セルフサインアップなし)、12 文字以上のパスワードポリシー、シークレットなしの PKCE クライアント、ゲストアクセスなしの ID プール、この ID プールの `authenticated` な ID だけを信頼するグループ別 IAM ロール、CloudFront OAC 経由の非公開 S3、HTTPS リダイレクト、CSP / HSTS / X-Frame-Options ヘッダー。

### 意図的に対象外(環境ごとに追加)

- WAF(リージョンの web ACL)。公開 API にする場合は追加する。
- 本番向けのエンドユーザー認証。デモ画面のユーザープールは MFA なし・脅威保護(Plus プラン)なしで、ディストリビューションは既定の `*.cloudfront.net` 証明書を使う。実運用の前に MFA、ACM 証明書付きの独自ドメイン、CloudFront 用の WAF web ACL を追加する。
- checkpoint データのカスタム暗号化(custom serdes)と durable execution データの CMK 暗号化。

### CDK Nag

`test/compliance/cdk-nag.test.ts` で AwsSolutions を検査しています。抑制はすべて `appliesTo` で対象を絞り、理由を記載しています(AWS 管理ポリシー 3 種、callback 用リソースの `:*`、KMS の `GenerateDataKey*`、状態 GSI の `index/*`、COG4、APIG3)。デモ画面の分として、COG2 / COG8(MFA、Plus プラン)、S1、CFR1〜4、execute-api ARN の `{requestId}` 用ワイルドカード、aws-cdk-lib が生成する BucketDeployment の関数をリソース単位で抑制しています。

## 📋 前提条件

- durable functions が使えるリージョンの AWS アカウント(デフォルトは `ap-northeast-1`。デプロイ前に提供状況を確認してください)、CDK ブートストラップ済み
- `${PROJECT}-${ENV}` プロファイルを設定した AWS CLI v2
- Node.js 22 以降、`aws-cdk-lib` 2.273.0 以降(`durableConfig`)
- Docker は不要(ローカルの esbuild でバンドル)
- API 呼び出し用に curl 7.75 以降(`--aws-sigv4`)と `jq`
- `parameters/dev-params.ts`: `workflow.approvalTimeoutMinutes`(既定 `48 * 60`)と `demoWebUi.enabled`(既定 `true`)。Cognito ドメインのプレフィックスは既定で `<project>-<env>-ldf-<account>`。リージョン内で一意で、`aws`・`amazon`・`cognito` を含められないため、該当する場合は `demoWebUi.cognitoDomainPrefix` で指定する

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install

export PROJECT=myproject
export ENV=dev

npm run bootstrap -w workspaces/lambda-durable-functions-approval   # 初回のみ
npm run diff -w workspaces/lambda-durable-functions-approval
npm run stage:deploy:all -w workspaces/lambda-durable-functions-approval
```

承認依頼やアラートをメールで受け取る場合は、`parameters/dev-params.ts` の `approverEmails` / `alertEmails` を設定し、届いた確認メールで購読を承認してください。

出力: `ApiUrl`、`WorkflowFunctionName`、`WorkflowAliasArn`、`RequestsTableName`、`WorkflowDlqUrl`。デモ画面を有効にした場合は `DemoWebUrl` と `DemoUserPoolId` も出力されます。

> 既存のテーブルに状態 GSI を追加したとき、CloudFormation はインデックスが `ACTIVE` になる約 8 分前に `UPDATE_COMPLETE` を返しました。その間 `GET /requests` は `Cannot read from backfilling global secondary index`(HTTP 502)で失敗します。

## 使い方

```bash
API="<ApiUrl の出力>"   # 例: https://xxxx.execute-api.ap-northeast-1.amazonaws.com/dev/
eval "$(aws configure export-credentials --profile ${PROJECT}-${ENV} --format env)"
SIGV4=(--aws-sigv4 "aws:amz:ap-northeast-1:execute-api" --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" -H "x-amz-security-token: ${AWS_SESSION_TOKEN}")

# 1. 申請(同じ Idempotency-Key と同じ body の再送は同じ実行になる)
curl -s "${SIGV4[@]}" -X POST "${API}requests" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: req-0001' \
  -d '{"title":"New laptop","amount":1200}' | jq

# 2. 状態(数秒後に WAITING_APPROVAL)
curl -s "${SIGV4[@]}" "${API}requests/req-0001" | jq

# 3. 承認(申請者とは別の IAM プリンシパルで実行する。同じだと 403)
curl -s "${SIGV4[@]}" -X POST "${API}requests/req-0001/decision" \
  -H 'Content-Type: application/json' -d '{"approved":true,"comment":"OK"}' | jq

# 4. 実行の内部状態(運用者向け。15〜30 rps の API 制限があるのでアプリからは使わない)
aws lambda list-durable-executions-by-function --function-name "<WorkflowFunctionName>" --statuses RUNNING --profile ${PROJECT}-${ENV}
```

## 🖥️ デモ用 Web 画面

```bash
# 申請者と承認者を 1 人ずつ作成する。パスワードはランダム生成して 1 度だけ表示し、メールは送らない
./scripts/create-demo-users.sh <DemoUserPoolId> requester@example.com approver@example.com \
  --profile ${PROJECT}-${ENV} --region ap-northeast-1
```

`DemoWebUrl` を 2 つのブラウザ(または通常ウィンドウとプライベートウィンドウ)で開き、それぞれのユーザーでサインインします。

| 申請者 | 承認者 |
|---|---|
| 件名と金額(任意で `Idempotency-Key`)を入れて申請し、`受付 → 承認待ち → 決定受信 → 完了` と進む様子を確認する。「自分で承認してみる」で API Gateway の 403 を確認できる。 | 作業一覧に `WAITING_APPROVAL` の申請が並ぶ。コメントを付けて承認または却下する。2 回目の決定は 409。結果一覧で完了・却下・期限切れを確認できる。 |

承認待ちの間、durable function は停止しており compute の課金はありません。`EXPIRED` の分岐を見たい場合は、`workflow.approvalTimeoutMinutes` を `2` にして再デプロイします。

## 🧪 テスト戦略

| 種類 | ファイル | 内容 |
|---|---|---|
| ワークフロー | `test/unit/approval-workflow.test.ts` | `@aws/durable-execution-sdk-js-testing` の `LocalDurableTestRunner` で、本物のオーケストレーションコードをローカルで実行する(承認 / 却下 / 外部からの callback 失敗 / step のリトライ / replay で step が再実行されないこと / 不正な決定) |
| スタック | `test/unit/lambda-durable-functions-approval-stack.test.ts` | `DurableConfig`、Version の `Retain`、エイリアス、IAM の範囲、EventBridge のパターン、状態 GSI など |
| デモ画面 | `test/unit/demo-web-ui.test.ts` | 管理者作成のみのユーザープール、PKCE クライアント、Deny 付きのトークンによるロールマッピング、グループ別ロールと execute-api の範囲、OAC、CSP、CORS(プリフライト、ゲートウェイレスポンス、ハンドラーのヘッダー)、無効時に何も作られないこと |
| スナップショット | `test/snapshot/` | テンプレート全体とリソース数 |
| コンプライアンス | `test/compliance/cdk-nag.test.ts` | AwsSolutions |

**制約**: testing SDK 1.3.x の `LocalDurableTestRunner` は callback のタイムアウトを発火させません。そのため期限切れの分岐は、`CallbackTimeoutError` を返すスタブの context で検証しています。実機ではデプロイ検証で確認済みで、タイムアウトを 2 分にすると、待機開始のちょうど 2 分後に `EXPIRED` になりました。

```bash
cd infrastructure/workspaces/lambda-durable-functions-approval
npx jest
```

## 🛠️ 運用

- **デプロイ**: エイリアスが新しいバージョンを指すのは新しい実行だけです。実行中のものは古いバージョンで最後まで進みます。
- **古いバージョンの削除**: `ListDurableExecutionsByFunction` で RUNNING の実行がないことを確認してから削除します。保持しているバージョンはコード保存領域のクォータを消費します。
- **再処理**: DLQ の元イベントを確認し、原因を直してから再投入します。同じ `DurableExecutionName` は保持期間中は再利用できないため、再処理では別の request ID を使います。
- **関数の削除**: CloudFormation は実行中の durable execution の完了を最長 1 時間待ち、その後タイムアウトします(`aws-cdk-lib` の README による)。削除前に実行を停止してください。
- **停止した実行**: `StopDurableExecution` は step を実行せずに実行を終わらせるため、DynamoDB のアイテムは最後の状態(例: `WAITING_APPROVAL`)のまま残り、承認者の一覧にも出続けます。決定しようとすると 409 です。手動で停止したときは、アイテムを更新または削除してください。
- **`ErrorCode` 400 の DLQ メッセージ**: `DurableExecutionAlreadyExists ... different payload` で拒否されたイベントは、request ID を違う body で再利用したもので、ワークフローの失敗ではありません。確認したら削除します。

## ✅ デプロイ検証の結果

2026-10-21 に ap-northeast-1 で、2 つの IAM プリンシパルと 2 人のデモユーザー(ID プールの認証情報)を使って確認しました。

| 確認項目 | 結果 |
|---|---|
| 署名なしのリクエスト | 403 `Missing Authentication Token` |
| body の検証(負の金額、余分なプロパティ) | API Gateway のモデルで 400 |
| 申請 → `WAITING_APPROVAL` | 約 1 秒。実行履歴は `register-request`、`wait-for-approval`(callback + submitter step)の後 `InvocationCompleted`(停止) |
| 同じキー・同じ body の再送 | 202、同じ実行 ARN、DLQ には何も入らない |
| 同じキー・違う body の再送 | 修正前: 202 + 既存 ARN、DLQ に `DurableExecutionAlreadyExists ... different payload` のイベント。修正後: 409 |
| 申請者本人による承認 | IAM プリンシパル: ハンドラーが 403。デモユーザー: API Gateway が 403(ロールに権限なし) |
| 承認 / 却下 | 202 → 約 3 秒で `COMPLETED`(`fulfillmentId` 付き)/ `REJECTED` |
| 2 回目の決定 | 409 |
| 承認期限(2 分) | 待機開始の 2 分後に `EXPIRED` |
| 待機中の実行への `StopDurableExecution` | `STOPPED`。EventBridge ルールが 1 回マッチしてアラートトピックへ配信、元イベントは DLQ へ。DynamoDB のアイテムは `WAITING_APPROVAL` のまま(運用を参照) |
| ID プールの認証情報 | どのユーザーでも ARN は `assumed-role/<グループのロール>/CognitoIdentityCredentials`。API は代わりに `cognito-identity:<identity id>` を記録する |
| CORS | プリフライトは画面のオリジン付きで 204。2xx・4xx(IAM による拒否を含む)・5xx のすべてに `Access-Control-Allow-Origin` が付く |
| CloudFront | 200、CSP・HSTS・`X-Frame-Options: DENY` 付き |

コマンドラインでは確認できなかったもの: マネージドログインの画面そのもの(JavaScript で描画されるため curl では操作できない)。サインイン後のトークン → ID プール → API の経路は、同じアプリクライアントで発行したトークンで確認しました。

## 🧹 クリーンアップ

```bash
# 待機中の実行があると関数の削除が待たされるため、先に停止する
aws lambda list-durable-executions-by-function --function-name "<WorkflowFunctionName>" --statuses RUNNING --profile ${PROJECT}-${ENV}
aws lambda stop-durable-execution --durable-execution-arn "<arn>" --profile ${PROJECT}-${ENV}

npm run stage:destroy:all -w workspaces/lambda-durable-functions-approval
```

`removalPolicy: RETAIN` を付けた `AWS::Lambda::Version` は、関数より長く残ることはありません。デプロイ検証では `cdk destroy` で関数と発行済みの 3 バージョンが削除され、`<project>-<env>-ldf` で始まるリソース(Lambda、DynamoDB、Cognito、CloudFront、SQS、SNS、ロググループ、IAM ロール)は残りませんでした。

## 📚 参考資料

### AWS ドキュメント(確認日: 2026-10-21)

- [Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
- [Invoking Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking.html) / [Event source mappings with durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking-esm.html)
- [Idempotency](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html) / [Security and permissions](https://docs.aws.amazon.com/lambda/latest/dg/durable-security.html)
- [Best practices](https://docs.aws.amazon.com/lambda/latest/dg/durable-best-practices.html) / [Monitoring](https://docs.aws.amazon.com/lambda/latest/dg/durable-monitoring.html)
- [Durable functions or Step Functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-step-functions.html)
- [Lambda quotas — Durable functions](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#durable-functions-quotas)
- [AWS Durable Execution SDK Developer Guide](https://docs.aws.amazon.com/durable-execution/)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)

### 関連アーキテクチャ

- [fis-arch-f-stepfunctions-saga](../fis-arch-f-stepfunctions-saga/) — 同じ「複数ステップ + 補償」を Step Functions で
- [apigw-single-purpose-lambda](../apigw-single-purpose-lambda/) — API Gateway + ルートごとの Lambda の基本形
- [eventbridge-custom-bus](../eventbridge-custom-bus/) — EventBridge のルーティング

## 📄 ライセンス

[LICENSE](../../LICENSE) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

**対象レベル**: 300(中級)
